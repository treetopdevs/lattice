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
}

impl<T> NativePending<T> {
    pub(crate) fn cancellation(&self) -> NativeCancellation {
        self.cancellation.clone()
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
    });
    // Dropping a Tokio/Tauri join handle detaches; aborting it would drop the
    // mobile receiver and let the later callback panic in the pinned helper.
    drop(task);
    NativePending {
        receiver,
        cancellation,
        current,
    }
}
