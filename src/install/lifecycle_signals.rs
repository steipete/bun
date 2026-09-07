//! SIGINT, SIGTERM and SIGHUP sent to `bun install` while a lifecycle script
//! runs (CI cancellation, `docker stop`, `timeout(1)`, a hung-up ssh session).
//!
//! Without this the default action ends `bun install` at once and every
//! running script is reparented to init, still writing into `node_modules`.
//! Instead, while at least one script runs, a handler forwards the signal to
//! each script and `bun install` waits. No new script starts. When the last
//! script has exited, `bun install` dies by the forwarded signal, the same way
//! it already does for a script that dies by a signal on its own. A second
//! signal sends SIGKILL to the scripts that are still running.
//!
//! The handler only records the signal and queues a task on the install event
//! loop (a lock-free push plus the loop's wakeup fd, both async-signal-safe).
//! The task runs on the install thread, where it can walk
//! `active_lifecycle_scripts`.
//!
//! The handlers are installed when the first script starts and removed when
//! the last one exits, so `bun install` with no script running keeps the
//! default action and ends at once.

use core::cell::UnsafeCell;
use core::ffi::c_int;
use core::ptr::NonNull;
use core::sync::atomic::{AtomicBool, AtomicI32, AtomicPtr, AtomicUsize, Ordering};

use bun_event_loop::AnyEventLoop;
use bun_event_loop::AnyTaskWithExtraContext::{AnyTaskWithExtraContext, New};
use bun_event_loop::MiniEventLoop::MiniEventLoop;

use crate::PackageManager;
use crate::lifecycle_script_runner::LifecycleScriptSubprocess;

const SIGNALS: [c_int; 3] = [libc::SIGINT, libc::SIGTERM, libc::SIGHUP];

/// The last signal received, 0 when none.
static PENDING: AtomicI32 = AtomicI32::new(0);
/// Set while `TASK` sits in the event loop queue. A node must not be pushed
/// twice. `PENDING` and `QUEUED` are `SeqCst`: a handler that finds `QUEUED`
/// set relies on the queued task to read its `PENDING` store, and the handler
/// can run on any thread.
static QUEUED: AtomicBool = AtomicBool::new(false);
/// Set once the scripts have been signalled and the install is draining.
static DRAINING: AtomicBool = AtomicBool::new(false);
/// Number of lifecycle scripts that are running right now.
static RUNNING: AtomicUsize = AtomicUsize::new(0);
static MANAGER: AtomicPtr<PackageManager> = AtomicPtr::new(core::ptr::null_mut());
static EVENT_LOOP: AtomicPtr<MiniEventLoop> = AtomicPtr::new(core::ptr::null_mut());
/// Allocated once by `install`, never freed: the handler must not allocate.
static TASK: AtomicPtr<AnyTaskWithExtraContext> = AtomicPtr::new(core::ptr::null_mut());

/// The dispositions replaced by `install`, restored by `uninstall`.
struct Previous(UnsafeCell<[libc::sigaction; SIGNALS.len()]>);
// SAFETY: only touched on the install thread, inside `install`/`uninstall`.
unsafe impl Sync for Previous {}
static PREVIOUS: Previous = Previous(UnsafeCell::new([bun_core::ffi::zeroed(); SIGNALS.len()]));

/// The signal that `bun install` received, if one is being forwarded to the
/// running scripts. While this is `Some`, no new lifecycle script starts and
/// an exiting script does not chain into the next one.
pub(crate) fn pending() -> Option<bun_core::SignalCode> {
    if !DRAINING.load(Ordering::Relaxed) {
        return None;
    }
    Some(received())
}

fn received() -> bun_core::SignalCode {
    u8::try_from(PENDING.load(Ordering::SeqCst))
        .ok()
        .and_then(bun_core::SignalCode::from_raw)
        .unwrap_or(bun_core::SignalCode::DEFAULT)
}

/// A lifecycle script is about to be spawned. Installs the handlers on the
/// first one.
///
/// `manager` is the live `PackageManager` that owns the script. It is stored
/// and dereferenced from the signal task until `on_script_exited` removes the
/// handlers, so it must carry allocation-rooted provenance, not a transient
/// `&mut` reborrow.
pub(crate) fn on_script_started(manager: *mut PackageManager) {
    if RUNNING.fetch_add(1, Ordering::Relaxed) == 0 {
        install(manager);
    }
}

/// A lifecycle script exited (after it left `active_lifecycle_scripts`), or
/// failed to spawn. Restores the dispositions after the last one, or dies by
/// the forwarded signal when draining.
pub(crate) fn on_script_exited() {
    if RUNNING.fetch_sub(1, Ordering::Relaxed) != 1 {
        return;
    }
    if let Some(sig) = pending() {
        die(sig);
    }
    uninstall();
}

fn die(sig: bun_core::SignalCode) -> ! {
    bun_core::Output::flush();
    bun_core::Global::raise_ignoring_panic_handler(sig);
}

fn install(manager: *mut PackageManager) {
    // SAFETY: `manager` is live (caller contract). Only the `event_loop`
    // field is projected, so no whole-struct `&mut PackageManager` exists.
    let event_loop: *mut AnyEventLoop = unsafe { &raw mut (*manager).event_loop };
    // SAFETY: `event_loop` points into the live manager (above).
    let AnyEventLoop::Mini(mini) = (unsafe { &mut *event_loop }) else {
        // Under a JS event loop the runtime owns the process signals.
        return;
    };
    let mini: *mut MiniEventLoop = &raw mut **mini;
    if TASK.load(Ordering::Relaxed).is_null() {
        // The task reads `MANAGER` itself; the context is unused.
        TASK.store(
            Box::leak(Box::new(New::<(), ()>::init(
                NonNull::<()>::dangling().as_ptr(),
                on_signal_task,
            ))),
            Ordering::Relaxed,
        );
    }
    MANAGER.store(manager, Ordering::Relaxed);
    // Before the dispositions: the handler never runs without a loop.
    EVENT_LOOP.store(mini, Ordering::Release);

    // SAFETY: all-zero is a valid `libc::sigaction`; `sigemptyset`/`sigaction`
    // take pointers to these stack and static values.
    unsafe {
        let mut act: libc::sigaction = bun_core::ffi::zeroed();
        act.sa_sigaction = handler as *const () as usize;
        act.sa_flags = libc::SA_RESTART;
        libc::sigemptyset(&raw mut act.sa_mask);
        let previous = &mut *PREVIOUS.0.get();
        for (i, sig) in SIGNALS.iter().enumerate() {
            let mut current: libc::sigaction = bun_core::ffi::zeroed();
            if libc::sigaction(*sig, core::ptr::null(), &raw mut current) != 0 {
                continue;
            }
            // An inherited SIG_IGN (`nohup`, a `&` job in a non-interactive
            // shell) stays ignored, as it is for the scripts themselves.
            if current.sa_sigaction == libc::SIG_IGN {
                previous[i] = current;
                continue;
            }
            libc::sigaction(*sig, &raw const act, &raw mut previous[i]);
        }
    }
}

fn uninstall() {
    if EVENT_LOOP.load(Ordering::Relaxed).is_null() {
        return;
    }
    // SAFETY: `PREVIOUS` holds the dispositions `install` replaced.
    unsafe {
        let previous = &*PREVIOUS.0.get();
        for (i, sig) in SIGNALS.iter().enumerate() {
            libc::sigaction(*sig, &raw const previous[i], core::ptr::null_mut());
        }
    }
    // After the dispositions: the handler never runs without a loop.
    EVENT_LOOP.store(core::ptr::null_mut(), Ordering::Release);
    MANAGER.store(core::ptr::null_mut(), Ordering::Relaxed);
}

extern "C" fn handler(sig: c_int) {
    PENDING.store(sig, Ordering::SeqCst);
    if QUEUED.swap(true, Ordering::SeqCst) {
        return;
    }
    let event_loop = EVENT_LOOP.load(Ordering::Acquire);
    if event_loop.is_null() {
        // Only reachable on another thread while `uninstall` restores the
        // dispositions, so no script runs. Take the default action rather
        // than drop the signal: `sig` is blocked inside its own handler, so
        // the re-raise lands on return.
        QUEUED.store(false, Ordering::SeqCst);
        // SAFETY: all-zero is a valid `libc::sigaction`; both calls are
        // async-signal-safe.
        unsafe {
            let mut act: libc::sigaction = bun_core::ffi::zeroed();
            act.sa_sigaction = libc::SIG_DFL;
            libc::sigaction(sig, &raw const act, core::ptr::null_mut());
            libc::raise(sig);
        }
        return;
    }
    // SAFETY: `EVENT_LOOP` is the live `MiniEventLoop` owned by the
    // `PackageManager` while the handlers are installed. `TASK` was allocated
    // by `install` before the handler existed, and it is not in the queue
    // (`QUEUED` was false).
    unsafe {
        let task = NonNull::new_unchecked(TASK.load(Ordering::Relaxed));
        (*event_loop).enqueue_task_concurrent(task);
    }
}

/// Runs on the install thread. Forwards the signal to every running script,
/// or SIGKILLs them when one was already forwarded.
fn on_signal_task(_: *mut (), _: *mut ()) {
    QUEUED.store(false, Ordering::SeqCst);
    let sig = received();
    let manager = MANAGER.load(Ordering::Relaxed);
    if manager.is_null() || RUNNING.load(Ordering::Relaxed) == 0 {
        // The last script exited between the handler and this task. Nothing
        // to wait for: the default action, now.
        die(sig);
    }
    let forward: u8 = if DRAINING.swap(true, Ordering::Relaxed) {
        bun_core::SignalCode::SIGKILL as u8
    } else {
        sig as u8
    };
    // SAFETY: `manager` is the live `PackageManager` stored by `install`;
    // this runs on the install thread between event loop ticks, so nothing
    // else walks or mutates the heap.
    unsafe {
        (*manager).active_lifecycle_scripts.for_each(
            |script: *mut LifecycleScriptSubprocess<'static>| {
                if let Some(process) = &(*script).process
                    && !process.process_mut().has_exited()
                {
                    let _ = process.kill(forward);
                }
            },
        );
    }
}
