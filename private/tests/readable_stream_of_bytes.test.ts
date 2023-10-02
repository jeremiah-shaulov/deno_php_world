import {ReadableStreamOfBytes} from '../readable_stream_of_bytes.ts';
import {assertEquals} from "../deps.ts";

Deno.test
(	'Await each',
	async () =>
	{	const BUFFER_SIZE = 13;
		for (let a=0; a<2; a++)
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
		for (let a=0; a<2; a++)
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
		for (let a=0; a<2; a++)
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
	{	for (let a=0; a<2; a++)
		{	for (const BUFFER_SIZE of a==0 ? [13] : [13, 3000, 10_000])
			{	let i = 1;
				const all = new Set<ArrayBufferLike>;
				const rs = new (a==0 ? ReadableStream : ReadableStreamOfBytes)
				(	{	type: 'bytes',
						autoAllocateChunkSize: BUFFER_SIZE,

						async pull(controller)
						{	const view = controller.byobRequest?.view;
							if (view)
							{	await new Promise(y => setTimeout(y, 3 - i%3));
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

				const r = rs.getReader();

				for (let i2=1; i2<100; i2++)
				{	const res = r.read();
					const res2 = r.read();

					const b = (await res).value!;
					const b2 = (await res2).value!;

					assertEquals(b.length, Math.min(i2, BUFFER_SIZE));
					for (let j=0; j<i2 && j<BUFFER_SIZE; j++)
					{	assertEquals(b[j], i2);
					}

					i2++;

					assertEquals(b2.length, Math.min(i2, BUFFER_SIZE));
					for (let j=0; j<i2 && j<BUFFER_SIZE; j++)
					{	assertEquals(b2[j], i2);
					}
				}
				if (a == 1)
				{	assertEquals(all.size, BUFFER_SIZE==13 ? 48 : BUFFER_SIZE==3000 ? 2 : 1);
				}
			}
		}
	}
);
