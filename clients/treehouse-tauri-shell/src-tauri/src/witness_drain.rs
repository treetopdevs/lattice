//! Native task ownership for a pending mobile callback. No command is registered.
//!
//! Tauri's mobile callback unwraps its response send. Dropping the caller must
//! therefore never abort the task that owns the mobile response receiver.

use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::async_runtime::{channel, Receiver};

pub(crate) const CALL_CANCELLED: &str = "cancelled";

/// Caller cancellation suppresses release; Kotlin cancellation is dispatched separately.
#[derive(Clone)]
pub(crate) struct NativeCancellation(Arc<AtomicBool>);

impl NativeCancellation {
    pub(crate) fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
}

pub(crate) struct NativePending<T> {
    receiver: Receiver<Result<T, &'static str>>,
    cancellation: NativeCancellation,
    current: Arc<dyn Fn() -> bool + Send + Sync>,
    drain: NativeDrain,
}

#[derive(Clone)]
pub(crate) struct NativeDrain(Arc<(std::sync::Mutex<DrainState>, std::sync::Condvar)>);

#[derive(Clone, Copy)]
enum DrainState {
    Pending,
    Drained,
    Failed,
}

struct DrainSignal {
    drain: NativeDrain,
    acknowledged: bool,
}

impl DrainSignal {
    fn acknowledge(mut self) {
        let (lock, ready) = &*self.drain.0;
        if let Ok(mut state) = lock.lock() {
            *state = DrainState::Drained;
            ready.notify_all();
        }
        self.acknowledged = true;
    }
}

impl Drop for DrainSignal {
    fn drop(&mut self) {
        if self.acknowledged {
            return;
        }
        let (lock, ready) = &*self.drain.0;
        if let Ok(mut state) = lock.lock() {
            *state = DrainState::Failed;
            ready.notify_all();
        }
    }
}

impl NativeDrain {
    pub(crate) async fn wait(&self) -> bool {
        let drain = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let (lock, ready) = &*drain.0;
            let Ok(mut state) = lock.lock() else {
                return false;
            };
            while matches!(*state, DrainState::Pending) {
                let Ok(next) = ready.wait(state) else {
                    return false;
                };
                state = next;
            }
            matches!(*state, DrainState::Drained)
        })
        .await
        .unwrap_or(false)
    }
}

impl<T> NativePending<T> {
    pub(crate) fn cancellation(&self) -> NativeCancellation {
        self.cancellation.clone()
    }
    pub(crate) fn drain(&self) -> NativeDrain {
        self.drain.clone()
    }

    pub(crate) async fn receive(mut self) -> Result<T, &'static str> {
        let result = self.receiver.recv().await.ok_or(CALL_CANCELLED)?;
        if self.cancellation.0.load(Ordering::Acquire) || !(self.current)() {
            Err(CALL_CANCELLED)
        } else {
            result
        }
    }
}

impl<T> Drop for NativePending<T> {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

/// `dispatch` must own its PluginHandle and copied request. It is awaited to its
/// terminal callback even when the public caller disappears. No abort handle escapes.
pub(crate) fn start_native_call<T, F, V>(dispatch: F, current: V) -> NativePending<T>
where
    T: Send + 'static,
    F: Future<Output = T> + Send + 'static,
    V: Fn() -> bool + Send + Sync + 'static,
{
    let (sender, receiver) = channel(1);
    let drain = NativeDrain(Arc::new((
        std::sync::Mutex::new(DrainState::Pending),
        std::sync::Condvar::new(),
    )));
    let signal = DrainSignal {
        drain: drain.clone(),
        acknowledged: false,
    };
    let cancellation = NativeCancellation(Arc::new(AtomicBool::new(false)));
    let task_cancellation = cancellation.clone();
    let current: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(current);
    let task_current = current.clone();
    let task = tauri::async_runtime::spawn(async move {
        let result = dispatch.await;
        let released = if task_cancellation.0.load(Ordering::Acquire) || !task_current() {
            Err(CALL_CANCELLED)
        } else {
            Ok(result)
        };
        // A lost caller is ordinary cancellation, not a native callback failure.
        let _ = sender.send(released).await;
        signal.acknowledge();
    });
    // Dropping a Tokio/Tauri join handle detaches; aborting it would drop the
    // mobile receiver and let the later callback panic in the pinned helper.
    drop(task);
    NativePending {
        receiver,
        cancellation,
        current,
        drain,
    }
}
