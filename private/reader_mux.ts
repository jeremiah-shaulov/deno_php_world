import {RdStream, TrStream} from './simple_streams/mod.ts';

export class ReaderMux
{	#inner_stream_promise: Promise<RdStream>;

	constructor(private inner_stream_promise: Promise<ReadableStream<Uint8Array> | null>, private end_mark: Uint8Array)
	{	this.#inner_stream_promise = this.inner_stream_promise.then(inner_stream => inner_stream ? RdStream.from(inner_stream) : new RdStream({read() {return 0}}));
	}

	async get_readable_stream(): Promise<RdStream>
	{	const inner_stream_promise = this.#inner_stream_promise;
		let py: (value: RdStream) => void;
		let pn: (error: Error) => void;
		this.#inner_stream_promise = new Promise((y, n) => {py=y; pn=n});
		const inner_stream = await inner_stream_promise;
		const mux = new ReadToMark(this.end_mark);
		const readable_stream = inner_stream.pipeThrough(mux);
		mux.writable.getWriterWhenReady().then
		(	writer => writer.closed.then
			(	() => inner_stream
			).finally
			(	() => writer.releaseLock()
			).then
			(	py,
				pn
			)
		);
		return readable_stream;
	}

	async dispose()
	{	const inner_stream = await this.#inner_stream_promise;
		inner_stream.cancel();
	}
}

class ReadToMark extends TrStream
{	constructor(public end_mark: Uint8Array)
	{	super
		(	{	async transform(writer, chunk, canRedo)
				{	let i = 0;
L:					for (const i_end=chunk.byteLength-end_mark.byteLength; i<=i_end; i++)
					{	for (let j=0, j_end=end_mark.byteLength, k=i; j<j_end; j++, k++)
						{	if (end_mark[j] != chunk[k])
							{	continue L;
							}
						}
						// Mark found at `i`
						if (i > 0)
						{	break;
						}
						await writer.close(); // await current write (if any) and close operations
						return end_mark.byteLength;
					}
					if (!canRedo)
					{	i = chunk.byteLength;
					}
					if (i > 0)
					{	await writer.ready; // await previous write
						writer.write(chunk.subarray(0, i)); // start new write
					}
					return i;
				}
			}
		);
	}
}
