// To run:
// rm -rf .vscode/coverage/profile && deno test --fail-fast --allow-all --coverage=.vscode/coverage/profile private/tests/simple_streams.test.ts && deno coverage --unstable .vscode/coverage/profile --lcov > .vscode/coverage/lcov.info

import {SimpleReadableStream, SimpleTransformStream, SimpleWritableStream} from '../simple_streams/mod.ts';
import {assertEquals} from "../deps.ts";

function read_to_pull(read: (view: Uint8Array) => number | null | Promise<number|null>, limitItems=Number.MAX_SAFE_INTEGER): UnderlyingByteSource
{	let i = 0;
	return {
		type: 'bytes',

		pull(controller: ReadableByteStreamController)
		{	const view = controller.byobRequest?.view;
			const readTo = !view ? new Uint8Array(8*1024) : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
			const resultOrPromise = read(readTo);
			function next(n: number|null)
			{	if (n == null)
				{	controller.close();
				}
				else if (view)
				{	controller.byobRequest.respond(n);
				}
				else
				{	controller.enqueue(readTo.subarray(0, n));
				}
				if (++i == limitItems)
				{	controller.close();
				}
			}
			if (typeof(resultOrPromise)=='number' || resultOrPromise==null)
			{	next(resultOrPromise);
			}
			else
			{	return resultOrPromise.then(next);
			}
		}
	};
}

function write_to_write(write: (chunk: Uint8Array) => number | Promise<number>)
{	return {
		write(chunk: Uint8Array)
		{	while (chunk.byteLength > 0)
			{	const resultOrPromise = write(chunk);
				if (typeof(resultOrPromise) == 'number')
				{	chunk = chunk.subarray(resultOrPromise);
				}
				else
				{	return resultOrPromise.then
					(	async nWritten =>
						{	chunk = chunk.subarray(nWritten);
							while (chunk.byteLength > 0)
							{	nWritten = await write(chunk);
								chunk = chunk.subarray(nWritten);
							}
						}
					);
				}
			}
		}
	};
}

Deno.test
(	'Reader: Callbacks',
	async () =>
	{	for (let c=0; c<3; c++) // cancel doesn't throw, cancel throws before awaiting, cancel throws after awaiting
		{	for (let a=0; a<2; a++) // ReadableStream or SimpleReadableStream
			{	let i = 0;
				const log = new Array<string>;

				// deno-lint-ignore no-inner-declarations
				async function start()
				{	log.push('<start>');
					await new Promise(y => setTimeout(y, 50));
					log.push('</start>');
				}

				// deno-lint-ignore no-inner-declarations
				async function read(view: Uint8Array)
				{	log.push('<read>');
					await new Promise(y => setTimeout(y, 10));
					view[0] = i++;
					log.push('</read>');
					return 1;
				}

				// deno-lint-ignore no-inner-declarations
				async function cancel()
				{	log.push('<cancel>');
					if (c == 1)
					{	throw new Error('Cancel failed');
					}
					await new Promise(y => setTimeout(y, 50));
					if (c == 2)
					{	throw new Error('Cancel failed');
					}
					log.push('</cancel>');
				}

				const rs = a==0 ? new ReadableStream({start, ...read_to_pull(read), cancel}) : new SimpleReadableStream({start, read, cancel});

				assertEquals(log, ['<start>']);

				const r = rs.getReader();
				r.closed.then(() => log.push('closed'), e => log.push('closed with error: '+e));
				let promise = r.read();

				assertEquals(log, ['<start>']);

				let res = await promise;

				assertEquals(log, ['<start>', '</start>', '<read>', '</read>']);
				assertEquals(res, {done: false, value: new Uint8Array([0])});

				promise = r.read();
				await new Promise(y => setTimeout(y, 1));

				assertEquals(log, ['<start>', '</start>', '<read>', '</read>', '<read>']);

				const promise2 = r.cancel();

				assertEquals(log, ['<start>', '</start>', '<read>', '</read>', '<read>', '<cancel>']);

				res = await promise;

				assertEquals(log, ['<start>', '</start>', '<read>', '</read>', '<read>', '<cancel>', 'closed']);
				assertEquals(res, {done: true, value: undefined});

				let error;
				try
				{	await promise2;
				}
				catch (e)
				{	error = e;
				}

				if (c == 0)
				{	assertEquals(log, ['<start>', '</start>', '<read>', '</read>', '<read>', '<cancel>', 'closed', '</read>', '</cancel>']);
				}
				else if (c == 1)
				{	assertEquals(error?.message, 'Cancel failed');
					assertEquals(log, ['<start>', '</start>', '<read>', '</read>', '<read>', '<cancel>', 'closed']);
				}
				else if (c == 2)
				{	assertEquals(error?.message, 'Cancel failed');
					assertEquals(log, ['<start>', '</start>', '<read>', '</read>', '<read>', '<cancel>', 'closed', '</read>']);
				}
			}
		}
	}
);

Deno.test
(	'Reader: Start throws async',
	async () =>
	{	for (let a=0; a<2; a++) // ReadableStream or SimpleReadableStream
		{	let i = 0;
			const log = new Array<string>;

			// deno-lint-ignore no-inner-declarations
			async function start()
			{	log.push('<start>');
				await new Promise(y => setTimeout(y, 50));
				throw new Error('Start failed');
			}

			// deno-lint-ignore no-inner-declarations
			async function read(view: Uint8Array)
			{	log.push('<read>');
				await new Promise(y => setTimeout(y, 10));
				view[0] = i++;
				log.push('</read>');
				return 1;
			}

			const rs = a==0 ? new ReadableStream({start, ...read_to_pull(read)}) : new SimpleReadableStream({start, read});

			assertEquals(log, ['<start>']);

			const r = rs.getReader();
			const promise = r.read();

			assertEquals(log, ['<start>']);

			let error;
			try
			{	await promise;
			}
			catch (e)
			{	error = e;
			}
			assertEquals(error?.message, 'Start failed');
			assertEquals(log, ['<start>']);
		}
	}
);

Deno.test
(	'Reader: Start throws sync',
	() =>
	{	for (let a=0; a<2; a++) // ReadableStream or SimpleReadableStream
		{	// deno-lint-ignore no-inner-declarations
			function start()
			{	throw new Error('Start failed');
			}

			// deno-lint-ignore no-inner-declarations
			function read(view: Uint8Array)
			{	view[0] = 0;
				return 1;
			}

			let error;
			try
			{	a==0 ? new ReadableStream({start, ...read_to_pull(read)}) : new SimpleReadableStream({start, read});
			}
			catch (e)
			{	error = e;
			}
			assertEquals(error?.message, 'Start failed');
		}
	}
);

Deno.test
(	'Reader: Cancel start',
	async () =>
	{	for (let a=0; a<2; a++) // ReadableStream or SimpleReadableStream
		{	let i = 0;
			const log = new Array<string>;
			let promiseStart: Promise<void> | undefined;

			// deno-lint-ignore no-inner-declarations
			async function start()
			{	log.push('<start>');
				promiseStart = new Promise(y => setTimeout(y, 50));
				await promiseStart;
				log.push('</start>');
			}

			// deno-lint-ignore no-inner-declarations
			async function read(view: Uint8Array)
			{	log.push('<read>');
				await new Promise(y => setTimeout(y, 10));
				view[0] = i++;
				log.push('</read>');
				return 1;
			}

			const rs = a==0 ? new ReadableStream({start, ...read_to_pull(read)}) : new SimpleReadableStream({start, read});

			assertEquals(log, ['<start>']);

			const r = rs.getReader();
			const promise = r.read();

			assertEquals(log, ['<start>']);

			await r.cancel();

			assertEquals(log, ['<start>']);

			const res = await promise;

			assertEquals(log, ['<start>']);

			await promiseStart;

			assertEquals(log, ['<start>', '</start>']);

			assertEquals(res, {done: true, value: undefined});
			assertEquals(log, ['<start>', '</start>']);
		}
	}
);

Deno.test
(	'Reader: Await each',
	async () =>
	{	const BUFFER_SIZE = 13;
		for (let s=0; s<2; s++) // read async, read sync
		{	for (let a=0; a<2; a++) // ReadableStream or SimpleReadableStream
			{	let i = 1;
				const all = new Set<ArrayBufferLike>;

				const read = s == 0 ?
					async function(view: Uint8Array)
					{	await new Promise(y => setTimeout(y, 3 - i%3));
						assertEquals(view.byteLength, BUFFER_SIZE);
						assertEquals(view.buffer.byteLength, BUFFER_SIZE);
						all.add(view.buffer);
						for (let j=0; j<i && j<BUFFER_SIZE; j++)
						{	view[j] = i;
						}
						return Math.min(i++, BUFFER_SIZE);
					} :
					function(view: Uint8Array)
					{	assertEquals(view.byteLength, BUFFER_SIZE);
						assertEquals(view.buffer.byteLength, BUFFER_SIZE);
						all.add(view.buffer);
						for (let j=0; j<i && j<BUFFER_SIZE; j++)
						{	view[j] = i;
						}
						return Math.min(i++, BUFFER_SIZE);
					};

				const rs = a==0 ? new ReadableStream(read_to_pull(read)) : new SimpleReadableStream({read});
				const r = rs.getReader({mode: 'byob'});
				let b = new Uint8Array(BUFFER_SIZE);
				for (let i2=1; i2<100; i2++)
				{	b = (await r.read(new Uint8Array(b.buffer, 0, b.buffer.byteLength))).value!;
					assertEquals(b.length, Math.min(i2, BUFFER_SIZE));
					for (let j=0; j<i2 && j<BUFFER_SIZE; j++)
					{	assertEquals(b[j], i2);
					}
				}
				if (a == 1)
				{	assertEquals(all.size, 1);
				}
			}
		}
	}
);

Deno.test
(	'Reader: 2 in parallel',
	async () =>
	{	const BUFFER_SIZE = 13;
		const BUFFER_SIZE_2 = 17;
		for (let s=0; s<2; s++) // read async, read sync
		{	for (let a=0; a<2; a++) // ReadableStream or SimpleReadableStream
			{	let i = 1;
				const all = new Set<ArrayBufferLike>;

				const read = s == 0 ?
					async function(view: Uint8Array)
					{	await new Promise(y => setTimeout(y, 3 - i%3));
						assertEquals(view.byteLength, i%2==1 ? BUFFER_SIZE : BUFFER_SIZE_2);
						assertEquals(view.buffer.byteLength, i%2==1 ? BUFFER_SIZE : BUFFER_SIZE_2);
						all.add(view.buffer);
						for (let j=0; j<i && j<view.buffer.byteLength; j++)
						{	view[j] = i;
						}
						return Math.min(i++, view.buffer.byteLength);
					} :
					function(view: Uint8Array)
					{	assertEquals(view.byteLength, i%2==1 ? BUFFER_SIZE : BUFFER_SIZE_2);
						assertEquals(view.buffer.byteLength, i%2==1 ? BUFFER_SIZE : BUFFER_SIZE_2);
						all.add(view.buffer);
						for (let j=0; j<i && j<view.buffer.byteLength; j++)
						{	view[j] = i;
						}
						return Math.min(i++, view.buffer.byteLength);
					};

				const rs = a==0 ? new ReadableStream(read_to_pull(read)) : new SimpleReadableStream({read});
				const r = rs.getReader({mode: 'byob'});
				let b = new Uint8Array(BUFFER_SIZE);
				let b2 = new Uint8Array(BUFFER_SIZE_2);
				for (let i2=1; i2<100; i2++)
				{	const res = r.read(new Uint8Array(b.buffer, 0, b.buffer.byteLength));
					const res2 = r.read(new Uint8Array(b2.buffer, 0, b2.buffer.byteLength));
					b = (await res).value!;
					b2 = (await res2).value!;

					assertEquals(b.length, Math.min(i2, b.buffer.byteLength));
					for (let j=0; j<i2 && j<b.buffer.byteLength; j++)
					{	assertEquals(b[j], i2);
					}

					i2++;

					assertEquals(b2.length, Math.min(i2, b2.buffer.byteLength));
					for (let j=0; j<i2 && j<b2.buffer.byteLength; j++)
					{	assertEquals(b2[j], i2);
					}
				}
				if (a == 1)
				{	assertEquals(all.size, 2);
				}
			}
		}
	}
);

Deno.test
(	'Reader: No byob',
	async () =>
	{	for (let a=0; a<2; a++) // ReadableStream or SimpleReadableStream
		{	for (const BUFFER_SIZE of a==0 ? [13] : [13, 3000, 10_000])
			{	const autoAllocateMin = BUFFER_SIZE >> 3;
				let i = 1;
				const all = new Set<ArrayBufferLike>;

				// deno-lint-ignore no-inner-declarations
				async function read(view: Uint8Array)
				{	await new Promise(y => setTimeout(y, 3 - i%3));
					all.add(view.buffer);
					for (let j=0; j<i && j<autoAllocateMin; j++)
					{	view[j] = i;
					}
					return Math.min(i++, autoAllocateMin);
				}

				const rs = a==0 ? new ReadableStream(read_to_pull(read)) : new SimpleReadableStream({autoAllocateChunkSize: BUFFER_SIZE, autoAllocateMin, read});
				const r = rs.getReader();
				for (let i2=1; i2<100; i2++)
				{	const res = r.read();
					const res2 = r.read();

					const b = (await res).value!;
					const b2 = (await res2).value!;

					assertEquals(b.length, Math.min(i2, autoAllocateMin));
					for (let j=0; j<i2 && j<autoAllocateMin; j++)
					{	assertEquals(b[j], i2);
					}

					i2++;

					assertEquals(b2.length, Math.min(i2, autoAllocateMin));
					for (let j=0; j<i2 && j<autoAllocateMin; j++)
					{	assertEquals(b2[j], i2);
					}
				}
				if (a == 1)
				{	assertEquals(all.size, BUFFER_SIZE==13 ? 8 : BUFFER_SIZE==3000 ? 2 : 1);
				}
			}
		}
	}
);

Deno.test
(	'Reader: Close, error',
	async () =>
	{	const BUFFER_SIZE = 13;
		for (let c=0; c<2; c++) // close or error
		{	for (let a=0; a<2; a++) // ReadableStream or SimpleReadableStream
			{	let i = 1;
				const all = new Set<ArrayBufferLike>;

				// deno-lint-ignore no-inner-declarations
				async function read(view: Uint8Array)
				{	await new Promise(y => setTimeout(y, 3 - i%3));
					assertEquals(view.byteLength, BUFFER_SIZE);
					assertEquals(view.buffer.byteLength, BUFFER_SIZE);
					all.add(view.buffer);
					if (i == 4)
					{	if (c == 0)
						{	return null;
						}
						else
						{	throw new Error('hello all');
						}
					}
					for (let j=0; j<i && j<BUFFER_SIZE; j++)
					{	view[j] = i;
					}
					return Math.min(i++, BUFFER_SIZE);
				}

				const rs = a==0 ? new ReadableStream(read_to_pull(read, c==0 ? 3 : Number.MAX_SAFE_INTEGER)) : new SimpleReadableStream({read});
				const r = rs.getReader({mode: 'byob'});
				let b = new Uint8Array(BUFFER_SIZE);
				for (let i2=1; i2<=3; i2++)
				{	b = (await r.read(new Uint8Array(b.buffer, 0, b.buffer.byteLength))).value!;
					assertEquals(b.length, Math.min(i2, BUFFER_SIZE));
					for (let j=0; j<i2 && j<BUFFER_SIZE; j++)
					{	assertEquals(b[j], i2);
					}
				}
				if (c == 0)
				{	const {value, done} = await r.read(new Uint8Array(b.buffer, 0, b.buffer.byteLength));
					assertEquals(done, true);
					assertEquals(value instanceof Uint8Array, true);

					r.releaseLock();
					const r2 = rs.getReader();
					const res = await r2.read();
					assertEquals(res.done, true);
					assertEquals(res.value === undefined, true);
				}
				else
				{	let error;
					try
					{	await r.read(new Uint8Array(b.buffer, 0, b.buffer.byteLength));
					}
					catch (e)
					{	error = e;
					}
					assertEquals(error?.message, 'hello all');

					r.releaseLock();
					const r2 = rs.getReader();
					error = undefined;
					try
					{	await r2.read();
					}
					catch (e)
					{	error = e;
					}
					assertEquals(error?.message, 'hello all');
				}
				if (a == 1)
				{	assertEquals(all.size, 1);
				}
			}
		}
	}
);

Deno.test
(	'Reader: Release',
	async () =>
	{	const BUFFER_SIZE = 13;
		for (let a=0; a<2; a++) // ReadableStream or SimpleReadableStream
		{	let i = 1;
			const all = new Set<ArrayBufferLike>;

			// deno-lint-ignore no-inner-declarations
			async function read(view: Uint8Array)
			{	await new Promise(y => setTimeout(y, 3 - i%3));
				assertEquals(view.byteLength, BUFFER_SIZE);
				assertEquals(view.buffer.byteLength, BUFFER_SIZE);
				all.add(view.buffer);
				for (let j=0; j<i && j<BUFFER_SIZE; j++)
				{	view[j] = i;
				}
				return Math.min(i++, BUFFER_SIZE);
			}

			const rs = a==0 ? new ReadableStream(read_to_pull(read)) : new SimpleReadableStream({read});
			let b = new Uint8Array(BUFFER_SIZE);
			let r = rs.getReader({mode: 'byob'});
			let promise = r.read(new Uint8Array(b.buffer, 0, b.buffer.byteLength));
			const res = await promise;
			assertEquals(res, {done: false, value: new Uint8Array([1])});
			b = res.value!;
			r.releaseLock();
			try
			{	promise = r.read(new Uint8Array(b.buffer, 0, b.buffer.byteLength));
				await promise;
			}
			catch (e)
			{	assertEquals(e instanceof TypeError, true);
				assertEquals(e.message, a==0 ? 'Reader has no associated stream.' : 'Reader or writer has no associated stream.');
			}

			r = rs.getReader({mode: 'byob'});
			promise = r.read(new Uint8Array(b.buffer, 0, b.buffer.byteLength));
			r.releaseLock();
			try
			{	await promise;
			}
			catch (e)
			{	assertEquals(e instanceof TypeError, true);
				assertEquals(e.message, a==0 ? 'The reader was released.' : 'Reader or writer has no associated stream.');
			}

			r.releaseLock();
		}
	}
);

Deno.test
(	'Reader: Invalid usage',
	async () =>
	{	const BUFFER_SIZE = 13;
		for (let a=0; a<2; a++) // ReadableStream or SimpleReadableStream
		{	let i = 1;
			const all = new Set<ArrayBufferLike>;

			// deno-lint-ignore no-inner-declarations
			async function read(view: Uint8Array)
			{	await new Promise(y => setTimeout(y, 3 - i%3));
				assertEquals(view.byteLength, BUFFER_SIZE);
				assertEquals(view.buffer.byteLength, BUFFER_SIZE);
				all.add(view.buffer);
				for (let j=0; j<i && j<BUFFER_SIZE; j++)
				{	view[j] = i;
				}
				return Math.min(i++, BUFFER_SIZE);
			}

			const rs = a==0 ? new ReadableStream(read_to_pull(read)) : new SimpleReadableStream({read});
			let b = new Uint8Array(BUFFER_SIZE);
			let r = rs.getReader({mode: 'byob'});
			try
			{	rs.getReader({mode: 'byob'});
			}
			catch (e)
			{	assertEquals(e instanceof TypeError, true);
				assertEquals(e.message, 'ReadableStream is locked.');
			}
			r.releaseLock();

			r = rs.getReader({mode: 'byob'});
			let res = await r.read(new Uint8Array(b.buffer, 0, b.buffer.byteLength));
			assertEquals(res, {done: false, value: new Uint8Array([1])});
			b = res.value!;

			try
			{	await rs.cancel();
			}
			catch (e)
			{	assertEquals(e instanceof TypeError, true);
				assertEquals(e.message, 'Cannot cancel a locked ReadableStream.');
			}
			r.releaseLock();

			await rs.cancel();

			r = rs.getReader({mode: 'byob'});
			res = await r.read(new Uint8Array(b.buffer, 0, b.buffer.byteLength));
			assertEquals(res.done, true);
		}
	}
);

Deno.test
(	'Reader: Tee and read in parallel',
	async () =>
	{	const BUFFER_SIZE = 13;
		for (let c=0; c<4; c++) // 0: no cancel, 1: cancel first, 2: cancel second, 3: cancel both
		{	for (let a=0; a<3; a++) // 0: ReadableStream, 1: SimpleReadableStream, 2: SimpleReadableStream with requireParallelRead
			{	let i = 1;
				const all = new Set<ArrayBufferLike>;
				const iAllocated = new Set<ArrayBufferLike>;
				const log = new Array<string>;
				let completeCancel: VoidFunction|undefined;

				// deno-lint-ignore no-inner-declarations
				async function read(view: Uint8Array)
				{	await new Promise(y => setTimeout(y, 3 - i%3));
					assertEquals(view.byteLength, BUFFER_SIZE);
					assertEquals(view.buffer.byteLength, BUFFER_SIZE);
					all.add(view.buffer);
					for (let j=0; j<i && j<BUFFER_SIZE; j++)
					{	view[j] = i;
					}
					if (i > 100)
					{	return null;
					}
					return Math.min(i++, BUFFER_SIZE);
				}

				// deno-lint-ignore no-inner-declarations
				async function cancel()
				{	log.push('cancel begin');
					await new Promise<void>(y => {completeCancel = y});
					log.push('cancel end');
				}

				const rs = a==0 ? new ReadableStream({...read_to_pull(read, 100), cancel}) : new SimpleReadableStream({read, cancel});

				await Promise.all
				(	(rs instanceof SimpleReadableStream && a==2 ? rs.tee({requireParallelRead: true}) : rs.tee()).map
					(	async (rs, nRs) =>
						{	const r = rs.getReader({mode: 'byob'});

							let b = new Uint8Array(BUFFER_SIZE);
							iAllocated.add(b.buffer);
							for (let i2=1; i2<=100; i2++)
							{	const promise = r.read(new Uint8Array(b.buffer, 0, b.buffer.byteLength));
								const wantCancel = nRs==0 && (c==1 || c==3) && i2==50 || nRs==1 && (c==2 || c==3) && i2==60;
								if (wantCancel)
								{	log.push('want cancel '+nRs);
									r.cancel();
									log.push('cancel called '+nRs);
								}
								const res = await promise;
								b = res.value!;
								if (wantCancel)
								{	log.push('cancelled '+nRs);
									assertEquals(res.value == undefined, a == 0);
									assertEquals(res.done, true);
									if (a == 0)
									{	// the buffer is detached
										b = new Uint8Array(BUFFER_SIZE);
									}
									break;
								}
								assertEquals(b.length, Math.min(i2, BUFFER_SIZE));
								for (let j=0; j<i2 && j<BUFFER_SIZE; j++)
								{	assertEquals(b[j], i2);
								}
							}

							const {value, done} = await r.read(new Uint8Array(b.buffer, 0, b.buffer.byteLength));
							assertEquals(done, true);
							assertEquals(value instanceof Uint8Array, true);
							r.releaseLock();

							const r2 = rs.getReader();
							const res = await r2.read();
							assertEquals(res.done, true);
						}
					)
				);

				if (a >= 1)
				{	for (const b of iAllocated)
					{	all.delete(b);
					}
					assertEquals(all.size, 0);
				}

				if (c == 1)
				{	assertEquals(log, ['want cancel 0', 'cancel called 0', 'cancelled 0']);
				}
				else if (c == 2)
				{	assertEquals(log, ['want cancel 1', 'cancel called 1', 'cancelled 1']);
				}
				else if (c == 3)
				{	assertEquals(log, ['want cancel 0', 'cancel called 0', 'cancelled 0', 'want cancel 1', 'cancel begin', 'cancel called 1', 'cancelled 1']);
				}
				completeCancel?.();
				await new Promise(y => setTimeout(y, 1));
				if (c == 1)
				{	assertEquals(log, ['want cancel 0', 'cancel called 0', 'cancelled 0']);
				}
				else if (c == 2)
				{	assertEquals(log, ['want cancel 1', 'cancel called 1', 'cancelled 1']);
				}
				else if (c == 3)
				{	assertEquals(log, ['want cancel 0', 'cancel called 0', 'cancelled 0', 'want cancel 1', 'cancel begin', 'cancel called 1', 'cancelled 1', 'cancel end']);
				}
			}
		}
	}
);

Deno.test
(	'Reader: Tee and read one after another',
	async () =>
	{	const BUFFER_SIZE = 13;
		for (let c=0; c<4; c++) // 0: no cancel, 1: cancel first, 2: cancel second, 3: cancel both
		{	for (let a=0; a<2; a++) // ReadableStream or SimpleReadableStream
			{	let i = 1;
				const all = new Set<ArrayBufferLike>;

				// deno-lint-ignore no-inner-declarations
				async function read(view: Uint8Array)
				{	await new Promise(y => setTimeout(y, 3 - i%3));
					all.add(view.buffer);
					for (let j=0; j<i && j<BUFFER_SIZE; j++)
					{	view[j] = i;
					}
					if (i > 100)
					{	return null;
					}
					return Math.min(i++, BUFFER_SIZE);
				}

				const rs = a==0 ? new ReadableStream(read_to_pull(read, 100)) : new SimpleReadableStream({read});
				const [rs1, rs2] = rs.tee();

				// rs1
				const r1 = rs1.getReader({mode: 'byob'});

				let b = new Uint8Array(BUFFER_SIZE);
				let totalLen = 0;
				for (let i2=1; i2<=100; i2++)
				{	for (let j=0; j<i2 && j<BUFFER_SIZE; j++)
					{	totalLen++;
					}
				}
				for (let i2=1; i2<=100; i2++)
				{	const promise = r1.read(new Uint8Array(b.buffer, 0, b.buffer.byteLength));
					if ((c==1 || c==3) && i2==60)
					{	r1.cancel();
					}
					const res = await promise;
					b = res.value!;
					if ((c==1 || c==3) && i2==60)
					{	assertEquals(res.value == undefined, a == 0);
						assertEquals(res.done, true);
						if (a == 0)
						{	// the buffer is detached
							b = new Uint8Array(BUFFER_SIZE);
						}
						break;
					}
					assertEquals(b.length, Math.min(i2, BUFFER_SIZE));
					for (let j=0; j<i2 && j<BUFFER_SIZE; j++)
					{	assertEquals(b[j], i2);
					}
				}

				const {value, done} = await r1.read(new Uint8Array(b.buffer, 0, b.buffer.byteLength));
				assertEquals(done, true);
				assertEquals(value instanceof Uint8Array, true);
				r1.releaseLock();

				const r12 = rs1.getReader();
				const res = await r12.read();
				assertEquals(res.done, true);

				// rs2
				const r2 = rs2.getReader({mode: 'byob'});
				if (c==2 || c==3)
				{	totalLen = 111;
				}
				let b2 = new Uint8Array(totalLen);
				let b2Offset = 0
				while (b2Offset < totalLen)
				{	const res2 = await r2.read(b2.subarray(b2Offset));
					assertEquals(res2.done, false);
					const nRead = res2.value?.byteLength ?? 0;
					assertEquals(nRead > 0, true);
					b2 = new Uint8Array(res2.value!.buffer);
					b2Offset += nRead;
				}
				assertEquals(b2Offset, totalLen);
				all.delete(b2.buffer);
				let k = 0;
				for (let i2=1; i2<=100; i2++)
				{	for (let j=0; j<i2 && j<BUFFER_SIZE; j++)
					{	if ((c==2 || c==3) && k>=totalLen)
						{	r2.cancel();
							break;
						}
						assertEquals(b2[k++], i2);
					}
				}
				assertEquals(k, totalLen);
				r2.releaseLock();

				// a
				if (a >= 1)
				{	assertEquals(all.size, 1);
				}

				const r22 = rs2.getReader();
				const res2 = await r22.read();
				assertEquals(res2.done, true);
			}
		}
	}
);

Deno.test
(	'PipeTo',
	async () =>
	{	const src = new Uint8Array(3000);
		for (let i=0; i<src.byteLength; i++)
		{	src[i] = Math.floor(Math.random() * 255);
		}
		for (let s=0; s<2; s++) // async write, sync write
		{	for (let p=0; p<2; p++) // without pipeThrough, with pipeThrough
			{	for (let a=0; a<2; a++) // ReadableStream or SimpleReadableStream
				{	for (let a2=0; a2<2; a2++) // WritableStream or SimpleWritableStream
					{	const dest = new Uint8Array(src.byteLength);
						let srcPos = 0;
						let destPos = 0;
						const all = new Set<ArrayBufferLike>;

						const read = async function(view: Uint8Array)
						{	await new Promise(y => setTimeout(y, 3 - srcPos/3%3));
							all.add(view.buffer);
							if (srcPos == src.byteLength)
							{	return null;
							}
							const n = Math.min(view.byteLength, src.byteLength-srcPos, Math.floor(Math.random() * src.byteLength/10) + 1);
							view.set(src.subarray(srcPos, srcPos+n));
							srcPos += n;
							return n;
						};

						const write = s == 0 ?
							async function(chunk: Uint8Array)
							{	await new Promise(y => setTimeout(y, 3 - destPos/3%3));
								const n = chunk.byteLength<=src.byteLength/20 ? chunk.byteLength : Math.ceil(Math.random() * chunk.byteLength);
								dest.set(chunk.subarray(0, n), destPos);
								destPos += n;
								return n;
							} :
							function(chunk: Uint8Array)
							{	const n = chunk.byteLength<=src.byteLength/20 ? chunk.byteLength : Math.ceil(Math.random() * chunk.byteLength);
								dest.set(chunk.subarray(0, n), destPos);
								destPos += n;
								return n;
							};

						const rs = a==0 ? new ReadableStream(read_to_pull(read, 3*1024)) : new SimpleReadableStream({read});
						const ws = a2==0 ? new WritableStream(write_to_write(write)) : new SimpleWritableStream({write});
						assertEquals(rs.locked, false);
						assertEquals(ws.locked, false);

						let useRs = rs;
						if (p == 1)
						{	useRs = rs.pipeThrough<Uint8Array>
							(	new SimpleTransformStream
								(	{	async transform(chunk, writer)
										{	for (let i=0; i<chunk.length; i++)
											{	chunk[i] = ~chunk[i];
											}
											await writer.write(chunk);
											return chunk.length;
										}
									}
								)
							);
						}

						await useRs.pipeTo(ws);

						assertEquals(rs.locked, false);
						assertEquals(ws.locked, false);
						assertEquals(dest, p==0 ? src : src.map(b => ~b));
					}
				}
			}
		}
	}
);

Deno.test
(	'Reader: Iterator',
	async () =>
	{	const BUFFER_SIZE = 13;
		let i = 1;
		const all = new Set<ArrayBufferLike>;
		const rs = new SimpleReadableStream
		(	{	autoAllocateMin: BUFFER_SIZE,

				async read(view)
				{	await new Promise(y => setTimeout(y, 3 - i%3));
					assertEquals(view.byteLength >= BUFFER_SIZE, true);
					all.add(view.buffer);
					for (let j=0; j<i && j<BUFFER_SIZE; j++)
					{	view[j] = i;
					}
					return Math.min(i++, BUFFER_SIZE);
				}
			}
		);

		assertEquals(rs.locked, false);
		let i2 = 1;
		for await (const b of rs)
		{	assertEquals(b.length, Math.min(i2, BUFFER_SIZE));
			for (let j=0; j<i2 && j<BUFFER_SIZE; j++)
			{	assertEquals(b[j], i2);
			}
			i2++;
			if (i2 == 100)
			{	break;
			}
		}
		assertEquals(rs.locked, false);

		assertEquals(all.size, 1);
	}
);

Deno.test
(	'Reader: From iterator',
	async () =>
	{	for (let s=0; s<5; s++) // sync iter of value, sync iter of promise, async iter, ReadableStream, ReadableStream bytes
		{	for (let a=0; a<2; a++) // ReadableStream or SimpleReadableStream
			{	let i = 1;
				const src =
					s == 0 ?
						[new Uint8Array([1, 1]), new Uint8Array([2, 2]), new Uint8Array([3, 3])] :
					s == 1 ?
						[Promise.resolve(new Uint8Array([1, 1])), Promise.resolve(new Uint8Array([2, 2])), Promise.resolve(new Uint8Array([3, 3]))] :
					s == 2 ?
						(	async function *()
							{	yield new Uint8Array([1, 1]);
								yield new Uint8Array([2, 2]);
								yield new Uint8Array([3, 3]);
							}
						)() :
					s == 3 ?
						ReadableStream.from([new Uint8Array([1, 1]), new Uint8Array([2, 2]), new Uint8Array([3, 3])]) :
						new ReadableStream
						(	{	type: 'bytes',
								pull(controller)
								{	const view = controller.byobRequest?.view;
									if (view)
									{	const view2 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
										view2[0] = i;
										view2[1] = i;
										controller.byobRequest.respond(2);
									}
									else
									{	controller.enqueue(new Uint8Array([i, i]));
									}
									if (++i == 4)
									{	controller.close();
									}
								}
							}
						);
				const rs = (a==0 ? ReadableStream : SimpleReadableStream).from(src);
				let i2 = 1;
				for await (const item of rs)
				{	assertEquals(item, new Uint8Array([i2, i2]));
					i2++;
				}
				assertEquals(i2, 4);
			}
		}
	}
);

Deno.test
(	'Writer',
	async () =>
	{	for (let a=0; a<2; a++) // WritableStream or SimpleWritableStream
		{	let src = new Uint8Array(3*1024);
			for (let i=0; i<src.byteLength; i++)
			{	src[i] = Math.floor(Math.random() * 255);
			}
			const dest = new Uint8Array(src.byteLength);
			let destLen = 0;

			// deno-lint-ignore no-inner-declarations
			async function write(chunk: Uint8Array)
			{	await new Promise(y => setTimeout(y, 3 - destLen/3%3));
				assertEquals(chunk.buffer.byteLength, src.buffer.byteLength);
				let i = 0;
				for (; i<3 && i<chunk.byteLength; i++)
				{	dest[destLen++] = chunk[i];
				}
				return i;
			}

			const ws = a==0 ? new WritableStream(write_to_write(write)) : new SimpleWritableStream({write});
			assertEquals(ws.locked, false);
			const w = ws.getWriter();
			while (src.byteLength > 0)
			{	const copyLen = Math.floor(Math.random() * 255);
				await w.write(src.subarray(0, copyLen));
				src = src.subarray(copyLen);
			}
			src = new Uint8Array(src.buffer);
			assertEquals(src, dest);
		}
	}
);
