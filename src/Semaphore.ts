/**
 * Basic single-reader-multiple-writer semaphore.
 *
 * This uses atomic operations and a SharedArrayBuffer to manage concurrent access from multiple threads.
 *
 * It holds onto 4 bytes of memory, which are interpreted as a 32-bit integer, X.
 *
 * * x === 0 = unlocked
 * * x === -1 = write locked
 * * x > 0 = read locked with x = number of read locks
 *
 * Usage:
 *
 * main thread:
 * ```typescript
 * import wt from 'worker_threads';
 * import { Semaphore } from 'Semaphore';
 * const semaphore = Semaphore.new();
 *
 * const sharedArrayBufferManagedBySemaphore = new SharedArrayBuffer(1024);
 * const uInt8Array = new Uint8Array(sharedArrayBufferManagedBySemaphore);
 *
 * const worker = new wt.Worker('./worker.js', {
 *   workerData: {
 *     semaphoreArrayBuffer: semaphore.arrayBuffer,
 *     sharedArrayBufferManagedBySemaphore,
 *   }
 * });
 *
 * semaphore.readLock();
 * console.log(uInt8Array[0]);
 * semaphore.readUnlock();
 * ```
 *
 * worker thread:
 * ```typescript
 * import { Semaphore } from 'Semaphore';
 *
 * const semaphore = Semaphore.from(wt.workerData.semaphoreArrayBuffer);
 * const sharedArrayBufferManagedBySemaphore = wt.workerData.sharedArrayBufferManagedBySemaphore;
 *
 * const uInt8Array = new Uint8Array(sharedArrayBufferManagedBySemaphore);
 *
 * semaphore.writeLock();
 * uInt8Array[0] = 1;
 * semaphore.writeUnlock();
 * ```
 *
 * Note: his does not properly handle unlocking in a worker thread where the thread is terminated.
 * Need to handle worker termination gracefully and specifically release locks
 *
 */
export class Semaphore {
	private static WRITE_LOCKED = -1;
	private static UNLOCKED = 0;
	private static BYTE_OFFSET = 0;

	public readonly ptr: ArrayBuffer;
	private readonly int32ArrayView: Int32Array;
	private __haveWriteLock: boolean = false;
	private __haveReadLock: boolean = false;

	private constructor(arrayBuffer: ArrayBuffer) {
		this.ptr = arrayBuffer;
		this.int32ArrayView = new Int32Array(arrayBuffer);
	}

	/**
	 * Create a new Semaphore with an optionally provided ArrayBuffer constructor
	 *
	 * Defaults to a thread safe SharedArrayBuffer constructor.
	 */
	public static new(
		arrayBufferConstructor: {
			new(byteLength: number): ArrayBuffer
		} = SharedArrayBuffer
	): Semaphore {
		return new Semaphore(new arrayBufferConstructor(4));
	}

	/** Create a semaphore from an existing ArrayBuffer. */
	public static from(arrayBuffer: ArrayBuffer): Semaphore {
		return new Semaphore(arrayBuffer);
	}

	/** Acquire write lock. */
	public writeLock(): void {
		if (this.haveReadLock) {
			throw new Error('Cannot acquire write lock without releasing read lock first');
		}
		if (this.haveWriteLock) {
			throw new Error('Cannot acquire write lock while already holding write lock');
		}
		// Try to write lock the buffer (-1), initially assuming it is unlocked (0)
		let lockState;
		while (
			(lockState = Atomics.compareExchange(
				this.int32ArrayView,
				Semaphore.BYTE_OFFSET,
				Semaphore.UNLOCKED,
				Semaphore.WRITE_LOCKED,
			)) !== Semaphore.UNLOCKED
			) {
			// If we failed to lock, wait for the buffer to be unlocked and try again
			Atomics.wait(
				this.int32ArrayView,
				Semaphore.BYTE_OFFSET,
				lockState,
			);
		}
		Atomics.notify(this.int32ArrayView, Semaphore.BYTE_OFFSET);
		this.__haveWriteLock = true;
	}

	/** Release write lock. */
	public writeUnlock(): void {
		if (!this.haveWriteLock) {
			throw new Error('Cannot release write lock without acquiring write lock first');
		}
		if (this.haveReadLock) {
			throw new Error('Semaphore corrupted: write and read lock held at the same time');
		}
		// Try to unlock the buffer
		if (
			Atomics.compareExchange(
				this.int32ArrayView,
				Semaphore.BYTE_OFFSET,
				Semaphore.WRITE_LOCKED,
				Semaphore.UNLOCKED,
			) !== Semaphore.WRITE_LOCKED
		) {
			throw new Error('Semaphore corrupted: holding write lock, but unable to unlock');
		}
		Atomics.notify(this.int32ArrayView, Semaphore.BYTE_OFFSET);
		this.__haveWriteLock = false;
	}

	/** Acquire read lock. */
	public readLock(): void {
		if (this.haveWriteLock) {
			throw new Error('Cannot acquire read lock without releasing write lock first');
		}
		if (this.haveReadLock) {
			throw new Error('Cannot acquire read lock while already holding read lock');
		}
		let lockState = Semaphore.UNLOCKED;
		let newLockState;
		// Try to read lock the buffer (lockStat+1), initially assuming it is unlocked (0)
		while ((newLockState = Atomics.compareExchange(
			this.int32ArrayView,
			Semaphore.BYTE_OFFSET,
			lockState,
			lockState + 1,
		)) !== lockState) {
			lockState = newLockState
			// If we failed to lock, and the buffer is locked, wait for the buffer to be unlocked and try again
			if (lockState === -1) {
				Atomics.wait(
					this.int32ArrayView,
					Semaphore.BYTE_OFFSET,
					Semaphore.WRITE_LOCKED,
				);
				// We need to reassert that it is locked when we hit the next while loop check
				lockState = Semaphore.UNLOCKED;
			}
			// If we got here, then the buffer is not write locked, but the lockState changed between the loops,
			// so try again with the new lock value
		}
		Atomics.notify(this.int32ArrayView, Semaphore.BYTE_OFFSET);
		this.__haveReadLock = true;
	}

	/** Release read lock. */
	public readUnlock(): void {
		if (!this.haveReadLock) {
			throw new Error('Cannot release read lock without acquiring read lock first');
		}
		if (this.haveWriteLock) {
			throw new Error('Semaphore corrupted: write and read lock held at the same time');
		}
		// Try to lock the buffer
		let lockState = 1;
		let newLockState;
		while (
			(newLockState = Atomics.compareExchange(
				this.int32ArrayView,
				Semaphore.BYTE_OFFSET,
				lockState,
				lockState - 1,
			)) !== lockState
		) {
			if (newLockState === Semaphore.WRITE_LOCKED) {
				throw new Error('Semaphore corrupted: Read lock was overridden by write lock');
			} else {
				lockState = newLockState
			}
		}
		Atomics.notify(this.int32ArrayView, Semaphore.BYTE_OFFSET);
		this.__haveReadLock = false;
	}

	public get haveWriteLock(): boolean {
		return this.__haveWriteLock;
	}

	public get haveReadLock(): boolean {
		return this.__haveReadLock;
	}
}
