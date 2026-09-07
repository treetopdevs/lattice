//! Private resource experiment; no product allocator or whole-process RSS claim.
use rquickjs::allocator::{Allocator, RustAllocator};
use std::alloc::Layout;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

// Pinned rquickjs-core 0.11.0 RustAllocator header/alignment on reviewed targets.
const ALIGN: usize = 8;
const HEADER: usize = 8;
const _: () = assert!(std::mem::size_of::<usize>() == 8);
const _: () = assert!(std::mem::align_of::<u64>() == ALIGN);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BudgetSnapshot {
    pub failed: bool,
    pub live_bytes: usize,
    pub peak_bytes: usize,
}

#[derive(Default)]
pub struct BudgetObserver {
    failed: AtomicBool,
    live: AtomicUsize,
    peak: AtomicUsize,
}

impl BudgetObserver {
    pub fn snapshot(&self) -> BudgetSnapshot {
        BudgetSnapshot {
            failed: self.failed.load(Ordering::SeqCst),
            live_bytes: self.live.load(Ordering::SeqCst),
            peak_bytes: self.peak.load(Ordering::SeqCst),
        }
    }
}

pub struct BudgetAllocator {
    inner: RustAllocator,
    limit: usize,
    live: usize,
    observer: Arc<BudgetObserver>,
    #[cfg(test)]
    fail_next_system_allocation: bool,
}

impl BudgetAllocator {
    pub fn new(limit: usize) -> Self {
        Self {
            inner: RustAllocator,
            limit,
            live: 0,
            observer: Arc::new(BudgetObserver::default()),
            #[cfg(test)]
            fail_next_system_allocation: false,
        }
    }

    pub fn observer(&self) -> Arc<BudgetObserver> {
        Arc::clone(&self.observer)
    }

    fn fail(&self) -> *mut u8 {
        self.observer.failed.store(true, Ordering::SeqCst);
        ptr::null_mut()
    }

    fn charge(size: usize) -> Option<usize> {
        let usable = size.checked_add(ALIGN - 1)? & !(ALIGN - 1);
        let charged = usable.checked_add(HEADER)?;
        Layout::from_size_align(charged, ALIGN).ok()?;
        Some(charged)
    }

    fn replacement_total(&self, old_charge: usize, new_size: usize) -> Option<usize> {
        let total = self
            .live
            .checked_sub(old_charge)?
            .checked_add(Self::charge(new_size)?)?;
        (total <= self.limit).then_some(total)
    }

    fn record(&mut self, live: usize) {
        self.live = live;
        self.observer.live.store(live, Ordering::SeqCst);
        self.observer.peak.fetch_max(live, Ordering::SeqCst);
    }

    fn injected_null(&mut self) -> bool {
        #[cfg(test)]
        {
            return std::mem::take(&mut self.fail_next_system_allocation);
        }
        #[cfg(not(test))]
        false
    }

    unsafe fn block_charge(p: *mut u8) -> Option<usize> {
        // SAFETY: callers supply only a live, non-null block from this allocator.
        unsafe { RustAllocator::usable_size(p) }.checked_add(HEADER)
    }
}

// SAFETY: every non-null pointer is returned by the pinned RustAllocator after
// checking its rounding, header and Layout arithmetic. Its alignment and usable
// size contract is preserved. Failed realloc leaves the old allocation live.
unsafe impl Allocator for BudgetAllocator {
    fn alloc(&mut self, size: usize) -> *mut u8 {
        let Some(total) = self.replacement_total(0, size) else {
            return self.fail();
        };
        if self.injected_null() {
            return self.fail();
        }
        let p = self.inner.alloc(size);
        if p.is_null() {
            return self.fail();
        }
        self.record(total);
        p
    }

    fn calloc(&mut self, count: usize, size: usize) -> *mut u8 {
        if count == 0 || size == 0 {
            return ptr::null_mut();
        }
        let Some(bytes) = count.checked_mul(size) else {
            return self.fail();
        };
        let Some(total) = self.replacement_total(0, bytes) else {
            return self.fail();
        };
        if self.injected_null() {
            return self.fail();
        }
        let p = self.inner.calloc(count, size);
        if p.is_null() {
            return self.fail();
        }
        self.record(total);
        p
    }

    unsafe fn dealloc(&mut self, p: *mut u8) {
        if p.is_null() {
            return;
        }
        // SAFETY: the trait requires a live pointer from this allocator.
        let charge = unsafe { Self::block_charge(p) };
        let remaining = charge.and_then(|charge| self.live.checked_sub(charge));
        unsafe { self.inner.dealloc(p) };
        match remaining {
            Some(total) => self.record(total),
            None => {
                self.fail();
                self.record(0);
            }
        }
    }

    unsafe fn realloc(&mut self, p: *mut u8, new_size: usize) -> *mut u8 {
        if p.is_null() {
            return self.alloc(new_size);
        }
        if new_size == 0 {
            unsafe { self.dealloc(p) };
            return ptr::null_mut();
        }
        // SAFETY: p remains owned and live until a successful underlying realloc.
        let Some(old_charge) = (unsafe { Self::block_charge(p) }) else {
            return self.fail();
        };
        let Some(total) = self.replacement_total(old_charge, new_size) else {
            return self.fail();
        };
        if self.injected_null() {
            return self.fail();
        }
        let resized = unsafe { self.inner.realloc(p, new_size) };
        if resized.is_null() {
            return self.fail();
        }
        self.record(total);
        resized
    }

    unsafe fn usable_size(p: *mut u8) -> usize {
        if p.is_null() {
            return 0;
        }
        unsafe { RustAllocator::usable_size(p) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_alignment_zeroing_multiple_blocks_and_release() {
        let mut allocator = BudgetAllocator::new(1024);
        let first = allocator.alloc(9);
        let second = allocator.calloc(3, 7);
        assert!(!first.is_null() && !second.is_null());
        assert_eq!(first as usize % ALIGN, 0);
        assert_eq!(second as usize % ALIGN, 0);
        unsafe {
            assert_eq!(BudgetAllocator::usable_size(first), 16);
            assert_eq!(BudgetAllocator::usable_size(second), 24);
            assert!(std::slice::from_raw_parts(second, 21)
                .iter()
                .all(|b| *b == 0));
            assert_eq!(allocator.observer.snapshot().live_bytes, 56);
            allocator.dealloc(first);
            allocator.dealloc(second);
        }
        assert_eq!(
            allocator.observer.snapshot(),
            BudgetSnapshot {
                failed: false,
                live_bytes: 0,
                peak_bytes: 56
            }
        );
    }

    #[test]
    fn exact_boundary_and_one_byte_over_are_checked_before_allocation() {
        let mut exact = BudgetAllocator::new(24);
        let p = exact.alloc(16);
        assert!(!p.is_null());
        unsafe { exact.dealloc(p) };
        let mut over = BudgetAllocator::new(24);
        assert!(over.alloc(17).is_null());
        assert_eq!(
            over.observer.snapshot(),
            BudgetSnapshot {
                failed: true,
                live_bytes: 0,
                peak_bytes: 0
            }
        );
    }

    #[test]
    fn overflow_and_invalid_layout_refuse_without_panic_or_allocation() {
        for (count, size) in [(usize::MAX, 2), (1, usize::MAX), (1, isize::MAX as usize)] {
            let mut allocator = BudgetAllocator::new(usize::MAX);
            assert!(allocator.calloc(count, size).is_null());
            assert!(allocator.observer.snapshot().failed);
            assert_eq!(allocator.observer.snapshot().live_bytes, 0);
        }
    }

    #[test]
    fn realloc_grow_shrink_and_failed_growth_preserve_owned_data() {
        let mut allocator = BudgetAllocator::new(64);
        unsafe {
            let p = allocator.alloc(8);
            p.write_bytes(0x5a, 8);
            let grown = allocator.realloc(p, 24);
            assert!(!grown.is_null());
            assert_eq!(std::slice::from_raw_parts(grown, 8), &[0x5a; 8]);
            assert!(allocator.realloc(grown, 57).is_null());
            assert_eq!(allocator.observer.snapshot().live_bytes, 32);
            assert_eq!(std::slice::from_raw_parts(grown, 8), &[0x5a; 8]);
            let shrunk = allocator.realloc(grown, 4);
            assert!(!shrunk.is_null());
            assert_eq!(std::slice::from_raw_parts(shrunk, 4), &[0x5a; 4]);
            assert_eq!(allocator.observer.snapshot().live_bytes, 16);
            allocator.dealloc(shrunk);
        }
        assert!(allocator.observer.snapshot().failed);
        assert_eq!(allocator.observer.snapshot().live_bytes, 0);
    }

    #[test]
    fn zero_and_null_conventions_do_not_invent_exhaustion() {
        let mut allocator = BudgetAllocator::new(64);
        assert!(allocator.calloc(0, usize::MAX).is_null());
        assert!(allocator.calloc(usize::MAX, 0).is_null());
        unsafe {
            let p = allocator.realloc(ptr::null_mut(), 8);
            assert!(!p.is_null());
            assert!(allocator.realloc(p, 0).is_null());
            let zero = allocator.alloc(0);
            assert!(!zero.is_null());
            assert_eq!(BudgetAllocator::usable_size(zero), 0);
            allocator.dealloc(zero);
            allocator.dealloc(ptr::null_mut());
        }
        assert!(!allocator.observer.snapshot().failed);
        assert_eq!(allocator.observer.snapshot().live_bytes, 0);
    }

    #[test]
    fn injected_system_null_preserves_old_allocation_and_sticks_across_cleanup() {
        let mut allocator = BudgetAllocator::new(128);
        unsafe {
            let p = allocator.alloc(8);
            p.write_bytes(42, 8);
            allocator.fail_next_system_allocation = true;
            assert!(allocator.realloc(p, 24).is_null());
            assert_eq!(std::slice::from_raw_parts(p, 8), &[42; 8]);
            assert_eq!(allocator.observer.snapshot().live_bytes, 16);
            allocator.dealloc(p);
        }
        let cleanup = allocator.alloc(8);
        assert!(!cleanup.is_null());
        unsafe { allocator.dealloc(cleanup) };
        assert!(allocator.observer.snapshot().failed);
        assert_eq!(allocator.observer.snapshot().live_bytes, 0);
        assert!(!BudgetAllocator::new(128).observer.snapshot().failed);
    }
}
