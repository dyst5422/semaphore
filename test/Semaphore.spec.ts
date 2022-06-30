import wt from 'worker_threads';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Semaphore } from '../src/Semaphore';

declare global {
	namespace jest {
		interface It {
			failing: It
		}
	}
}


describe('Semaphore', () => {
	it('should allow initializing a new semaphore', () => {
		const semaphore = Semaphore.new();
		expect(semaphore).toBeInstanceOf(Semaphore);
	});

	it('should allow initializing from an existing semaphore', () => {
		const semaphore0 = Semaphore.new();
		const semaphore1 = Semaphore.from(semaphore0.ptr);
		expect(semaphore1).toBeInstanceOf(Semaphore);
	});

	describe('writeLock', () => {
		it('should allow write locking', () => {
			const semaphore = Semaphore.new();
			expect(() => semaphore.writeLock()).not.toThrow();
		});

		it('should throw trying to acquire write lock when write lock is already held', () => {
			const semaphore = Semaphore.new();
			semaphore.writeLock();
			expect(() => semaphore.writeLock()).toThrow();
		});

		it('should throw trying to acquire write lock when read lock is already held', () => {
			const semaphore = Semaphore.new();
			semaphore.readLock();
			expect(() => semaphore.writeLock()).toThrow();
		});
	});

	describe('writeUnlock', () => {
		it('should allow write unlocking', () => {
			const semaphore = Semaphore.new();
			semaphore.writeLock();
			expect(() => semaphore.writeUnlock()).not.toThrow();
		});

		it('should throw trying to release write lock when no write lock held', () => {
			const semaphore = Semaphore.new();
			expect(() => semaphore.writeUnlock()).toThrow();
		});
	});

	describe('readLock', () => {
		it('should allow read locking', () => {
			const semaphore = Semaphore.new();
			expect(() => semaphore.readLock()).not.toThrow();
		});

		it('should throw trying to acquire read lock when read lock is already held', () => {
			const semaphore = Semaphore.new();
			semaphore.readLock();
			expect(() => semaphore.readLock()).toThrow();
		});

		it('should throw trying to acquire read lock when write lock is already held', () => {
			const semaphore = Semaphore.new();
			semaphore.writeLock();
			expect(() => semaphore.readLock()).toThrow();
		});
	});

	describe('readUnlock', () => {
		it('should allow read unlocking', () => {
			const semaphore = Semaphore.new();
			semaphore.readLock();
			expect(() => semaphore.readUnlock()).not.toThrow();
		});

		it('should throw trying to release read lock when no read lock held', () => {
			const semaphore = Semaphore.new();
			expect(() => semaphore.readUnlock()).toThrow();
		});
	});

	describe('concurrency', () => {
		it('should allow concurrent read locking', async () => {
			const semaphore = Semaphore.new();
			const tmpDirPath = await fs.promises.mkdtemp(os.tmpdir());
			const currentDir = path.dirname(new URL(import.meta.url).pathname);
			const workerPath = `${tmpDirPath}/worker.mjs`;
			await fs.promises.writeFile(workerPath, `
				import wt from 'worker_threads';
				import { Semaphore } from '${currentDir}/../build/Semaphore.js';
				const semaphore = Semaphore.from(wt.workerData.semaphorePtr);
				semaphore.readLock();
				wt.parentPort.postMessage(true);
				while(performance.now() - startTime < 1000) {};
			`);
			const worker = new wt.Worker(workerPath, {
				workerData: {
					semaphorePtr: semaphore.ptr
				}
			});

			await new Promise(resolve => worker.once('message', resolve));

			expect(() => semaphore.readLock()).not.toThrow()
			await worker.terminate();
		});

		it('should allow single write locking', async () => {
			const semaphore = Semaphore.new();
			const tmpDirPath = await fs.promises.mkdtemp(os.tmpdir());
			const currentDir = path.dirname(new URL(import.meta.url).pathname);
			const workerPath = `${tmpDirPath}/worker.mjs`;
			await fs.promises.writeFile(workerPath, `
				import wt from 'worker_threads';
				import { performance } from 'perf_hooks';
				import { Semaphore } from '${currentDir}/../build/Semaphore.js';
				const semaphore = Semaphore.from(wt.workerData.semaphorePtr);
				semaphore.writeLock();
				wt.parentPort.postMessage(true);
				const startTime = performance.now();
				while(performance.now() - startTime < 1000) {};
			`);
			const worker = new wt.Worker(workerPath, {
				workerData: {
					semaphorePtr: semaphore.ptr
				}
			});

			await new Promise(resolve => worker.once('message', resolve));

			expect(() => semaphore.readLock()).not.toThrow();
			await worker.terminate();
		});

		it.failing('should clear locks on worker termination', async () => {
			const semaphore = Semaphore.new();
			const tmpDirPath = await fs.promises.mkdtemp(os.tmpdir());
			const currentDir = path.dirname(new URL(import.meta.url).pathname);
			const workerPath = `${tmpDirPath}/worker.mjs`;
			await fs.promises.writeFile(workerPath, `
				import wt from 'worker_threads';
				import { Semaphore } from '${currentDir}/../build/Semaphore.js';
				const semaphore = Semaphore.from(wt.workerData.semaphorePtr);
				semaphore.writeLock();
				process.on('exit', () => {
					console.log('exit');
				});
				wt.parentPort.postMessage(true);
				await new Promise(resolve => wt.parentPort.once('message', resolve));
			`);
			const worker = new wt.Worker(workerPath, {
				workerData: {
					semaphorePtr: semaphore.ptr
				}
			});

			await new Promise(resolve => worker.once('message', resolve));
			expect(new Int32Array(semaphore.ptr)).toEqual(new Int32Array([-1]));
			worker.postMessage(true);
			await worker.terminate();
			expect(new Int32Array(semaphore.ptr)).toEqual(new Int32Array([0]));
		});
	});

});
