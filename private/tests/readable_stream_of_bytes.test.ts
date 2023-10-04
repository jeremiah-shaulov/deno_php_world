import {ReadableStreamOfBytes} from '../readable_stream_of_bytes.ts';
import {assertEquals} from "../deps.ts";

Deno.test
(	'Await each',
	async () =>
	{	const BUFFER_SIZE = 13;
		for (let a=0; a<2; a++) // ReadableStream or ReadableStreamOfBytes
		{	let i = 1;
			const all = new Set<ArrayBufferLike>;
			const rs = new (a==0 ? ReadableStream : ReadableStreamOfBytes)
			(	{	type: 'bytes',

					async pull(controller)
					{	const view = controller.byobRequest?.view;
						if (view)
						{	await new Promise(y => setTimeout(y, 3 - i%3));
							assertEquals(view.byteLength, BUFFER_SIZE);
							assertEquals(view.buffer.byteLength, BUFFER_SIZE);
							all.add(view.buffer);
							const view2 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
							for (let j=0; j<i && j<BUFFER_SIZE; j++)
							{	view2[j] = i;
							}
							controller.byobRequest!.respond(Math.min(i, BUFFER_SIZE));
							i++;
						}
					}
				}
			);

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
);

Deno.test
(	'2 in parallel',
	async () =>
	{	const BUFFER_SIZE = 13;
		const BUFFER_SIZE_2 = 17;
		for (let a=0; a<2; a++) // ReadableStream or ReadableStreamOfBytes
		{	let i = 1;
			const all = new Set<ArrayBufferLike>;
			const rs = new (a==0 ? ReadableStream : ReadableStreamOfBytes)
			(	{	type: 'bytes',

					async pull(controller)
					{	const view = controller.byobRequest?.view;
						if (view)
						{	await new Promise(y => setTimeout(y, 3 - i%3));
							assertEquals(view.byteLength, i%2==1 ? BUFFER_SIZE : BUFFER_SIZE_2);
							assertEquals(view.buffer.byteLength, i%2==1 ? BUFFER_SIZE : BUFFER_SIZE_2);
							all.add(view.buffer);
							const view2 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
							for (let j=0; j<i && j<view.buffer.byteLength; j++)
							{	view2[j] = i;
							}
							controller.byobRequest!.respond(Math.min(i, view.buffer.byteLength));
							i++;
						}
					}
				}
			);

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
);

Deno.test
(	'No pull, only start',
	async () =>
	{	const BUFFER_SIZE = 13;
		for (let a=0; a<2; a++) // ReadableStream or ReadableStreamOfBytes
		{	const rs = new (a==0 ? ReadableStream : ReadableStreamOfBytes)
			(	{	type: 'bytes',

					async start(controller)
					{	for (let i2=1; i2<100; i2++)
						{	await new Promise(y => setTimeout(y, 3 - i2%3));
							controller.enqueue(new Uint8Array([i2, i2]));
						}
						controller.close();
					}
				}
			);

			const r = rs.getReader({mode: 'byob'});

			let b = new Uint8Array(BUFFER_SIZE);
			for (let i2=1; i2<100; i2++)
			{	b = (await r.read(new Uint8Array(b.buffer, 0, b.buffer.byteLength))).value!;
				assertEquals(b.length, 2);
				assertEquals(b[0], i2);
				assertEquals(b[1], i2);
			}

			const res = await r.read(new Uint8Array(b.buffer, 0, b.buffer.byteLength));
			assertEquals(res.done, true);
		}
	}
);

Deno.test
(	'No byob',
	async () =>
	{	for (let a=0; a<2; a++) // ReadableStream or ReadableStreamOfBytes
		{	for (const BUFFER_SIZE of a==0 ? [13] : [13, 3000, 10_000])
			{	const autoAllocateMin = BUFFER_SIZE >> 3;
				let i = 1;
				const all = new Set<ArrayBufferLike>;
				const rs = new (a==0 ? ReadableStream : ReadableStreamOfBytes)
				(	{	type: 'bytes',
						autoAllocateChunkSize: BUFFER_SIZE,
						autoAllocateMin,

						async pull(controller)
						{	const view = controller.byobRequest?.view;
							if (view)
							{	await new Promise(y => setTimeout(y, 3 - i%3));
								all.add(view.buffer);
								const view2 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
								for (let j=0; j<i && j<autoAllocateMin; j++)
								{	view2[j] = i;
								}
								controller.byobRequest!.respond(Math.min(i, autoAllocateMin));
								i++;
							}
						}
					}
				);

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
(	'Close, error',
	async () =>
	{	const BUFFER_SIZE = 13;
		for (let c=0; c<2; c++) // close or error
		{	for (let a=0; a<2; a++) // ReadableStream or ReadableStreamOfBytes
			{	let i = 1;
				const all = new Set<ArrayBufferLike>;
				const rs = new (a==0 ? ReadableStream : ReadableStreamOfBytes)
				(	{	type: 'bytes',

						async pull(controller)
						{	const view = controller.byobRequest?.view;
							if (view)
							{	await new Promise(y => setTimeout(y, 3 - i%3));
								assertEquals(view.byteLength, BUFFER_SIZE);
								assertEquals(view.buffer.byteLength, BUFFER_SIZE);
								all.add(view.buffer);
								const view2 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
								for (let j=0; j<i && j<BUFFER_SIZE; j++)
								{	view2[j] = i;
								}
								controller.byobRequest!.respond(Math.min(i, BUFFER_SIZE));
								if (i == 3)
								{	if (c == 0)
									{	controller.close();
									}
									else
									{	controller.error('hello all');
									}
								}
								i++;
							}
						}
					}
				);

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
					assertEquals(error, 'hello all');

					r.releaseLock();
					const r2 = rs.getReader();
					error = undefined;
					try
					{	await r2.read();
					}
					catch (e)
					{	error = e;
					}
					assertEquals(error, 'hello all');
				}
				if (a == 1)
				{	assertEquals(all.size, 1);
				}
			}
		}
	}
);

Deno.test
(	'Tee and read in parallel',
	async () =>
	{	const BUFFER_SIZE = 13;
		for (let a=0; a<3; a++) // ReadableStream, ReadableStreamOfBytes, ReadableStreamOfBytes with requireParallelRead
		{	let i = 1;
			const all = new Set<ArrayBufferLike>;
			const rs = new (a==0 ? ReadableStream : ReadableStreamOfBytes)
			(	{	type: 'bytes',

					async pull(controller)
					{	const view = controller.byobRequest?.view;
						if (view)
						{	await new Promise(y => setTimeout(y, 3 - i%3));
							assertEquals(view.byteLength, BUFFER_SIZE);
							assertEquals(view.buffer.byteLength, BUFFER_SIZE);
							all.add(view.buffer);
							const view2 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
							for (let j=0; j<i && j<BUFFER_SIZE; j++)
							{	view2[j] = i;
							}
							controller.byobRequest!.respond(Math.min(i, BUFFER_SIZE));
							if (i == 100)
							{	controller.close();
							}
							i++;
						}
					}
				}
			);

			await Promise.all
			(	(rs instanceof ReadableStreamOfBytes && a==2 ? rs.tee({requireParallelRead: true}) : rs.tee()).map
				(	async rs =>
					{	const r = rs.getReader({mode: 'byob'});

						let b = new Uint8Array(BUFFER_SIZE);
						for (let i2=1; i2<=100; i2++)
						{	b = (await r.read(new Uint8Array(b.buffer, 0, b.buffer.byteLength))).value!;
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

						if (a == 1)
						{	assertEquals(all.size, 1);
						}
					}
				)
			);
		}
	}
);

Deno.test
(	'Tee and read one after another',
	async () =>
	{	const BUFFER_SIZE = 13;
		for (let a=0; a<2; a++) // ReadableStream or ReadableStreamOfBytes
		{	let i = 1;
			const all = new Set<ArrayBufferLike>;
			const rs = new (a==0 ? ReadableStream : ReadableStreamOfBytes)
			(	{	type: 'bytes',

					async pull(controller)
					{	const view = controller.byobRequest?.view;
						if (view)
						{	await new Promise(y => setTimeout(y, 3 - i%3));
							assertEquals(view.byteLength, BUFFER_SIZE);
							assertEquals(view.buffer.byteLength, BUFFER_SIZE);
							all.add(view.buffer);
							const view2 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
							for (let j=0; j<i && j<BUFFER_SIZE; j++)
							{	view2[j] = i;
							}
							controller.byobRequest!.respond(Math.min(i, BUFFER_SIZE));
							if (i == 100)
							{	controller.close();
							}
							i++;
						}
					}
				}
			);

			const [rs1, rs2] = rs.tee();

			// rs1
			const r1 = rs1.getReader({mode: 'byob'});

			let b = new Uint8Array(BUFFER_SIZE);
			let totalLen = 0;
			for (let i2=1; i2<=100; i2++)
			{	b = (await r1.read(new Uint8Array(b.buffer, 0, b.buffer.byteLength))).value!;
				assertEquals(b.length, Math.min(i2, BUFFER_SIZE));
				for (let j=0; j<i2 && j<BUFFER_SIZE; j++)
				{	assertEquals(b[j], i2);
					totalLen++;
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
			let res2 = await r2.read(new Uint8Array(totalLen));
			assertEquals(res2.done, false);
			assertEquals(res2.value?.byteLength, totalLen);
			let k = 0;
			for (let i2=1; i2<=100; i2++)
			{	for (let j=0; j<i2 && j<BUFFER_SIZE; j++)
				{	assertEquals(res2.value?.[k++], i2);
				}
			}
			assertEquals(k, totalLen);
			r2.releaseLock();

			const r22 = rs2.getReader();
			res2 = await r22.read();
			assertEquals(res2.done, true);

			// a
			if (a == 1)
			{	assertEquals(all.size, 1);
			}
		}
	}
);
