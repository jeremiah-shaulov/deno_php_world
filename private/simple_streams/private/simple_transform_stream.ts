import {PipeThroughTerminatedError} from './common.ts';
import {SimpleReadableStream} from './simple_readable_stream.ts';
import {SimpleWritableStream, Writer, WriteCallbackAccessor} from './simple_writable_stream.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

type CallbackStartOrFlush = (writer: Writer) => void | PromiseLike<void>;
type CallbackTransform = (writer: Writer, chunk: Uint8Array, canRedo: boolean) => number | PromiseLike<number>;

export type Transformer =
{	start?: CallbackStartOrFlush;
	transform?: CallbackTransform;
	flush?: CallbackStartOrFlush;
};

const EMPTY_CHUNK = new Uint8Array;

export class SimpleTransformStream extends TransformStream<Uint8Array, Uint8Array>
{	readonly readable: SimpleReadableStream;
	readonly writable: SimpleWritableStream;
	readonly overrideAutoAllocateChunkSize: number|undefined;

	constructor(transformer: Transformer)
	{	super();

		const {start, transform, flush} = transformer;
		let currentChunk = EMPTY_CHUNK;
		let currentChunkResolve: ((n: number) => void) | undefined;
		let currentViewResolve: ((n: number|null) => void) | undefined;
		let currentViewReject: ((reason: Any) => void) | undefined;
		let isEof = false;
		let isError = false;
		let error: Any;

		// Callbacks will write to this writer data that is about to be read by `this.readable`
		const writer = new Writer
		(	new WriteCallbackAccessor
			(	{	write(chunk)
					{	if (currentViewResolve)
						{	const n = Math.min(currentChunk.byteLength, chunk.byteLength);
							currentChunk.set(chunk.subarray(0, n));
							currentViewResolve(n);
							currentViewResolve = undefined;
							currentViewReject = undefined;
							return n;
						}
						else
						{	currentChunk = chunk;
							return new Promise(y => {currentChunkResolve = y});
						}
					},

					close()
					{	// `transform()` called `writer.close()`
						isEof = true;
						currentChunk = EMPTY_CHUNK;
						currentViewResolve?.(null);
						currentViewResolve = undefined;
						currentViewReject = undefined;
					},

					abort(reason)
					{	// `transform()` called `writer.abort()`
						isError = true;
						error = reason;
						isEof = true;
						currentChunk = EMPTY_CHUNK;
						currentViewReject?.(error);
						currentViewResolve = undefined;
						currentViewReject = undefined;
					},
				},
				true
			),

			// onRelease()
			() =>
			{	// `transform()` called `writer.releaseLock()`
				isError = true;
				error = new Error('Writer disassociated');
				isEof = true;
				currentChunk = EMPTY_CHUNK;
				currentViewReject?.(error);
				currentViewResolve = undefined;
				currentViewReject = undefined;
			}
		);

		// User (typically `pipeThrough()`) will write to here the original stream.
		// Data written to here is passed to `transform()` that is expected to call `writer.write()`.
		this.writable = new SimpleWritableStream
		(	{	start: !start ? undefined : () => start(writer),

				write: transform ?
					((chunk, canRedo) => !isEof ? transform(writer, chunk, canRedo) : Promise.reject(error ?? new PipeThroughTerminatedError('This transformer is terminated'))) :
					((chunk, canRedo) => writer.useLowLevelCallbacks(callbacks => callbacks.write!(chunk, canRedo)).then(n => n==undefined ? Promise.reject('This writer is closed') : n)),

				async close()
				{	// Input stream ended
					try
					{	await flush?.(writer);
					}
					finally
					{	await writer.close();
					}
				},

				abort(reason)
				{	return writer.abort(reason);
				},
			}
		);

		// Consumer will read from here the transformed stream
		this.readable = new SimpleReadableStream
		(	{	read(view)
				{	if (isEof)
					{	if (isError)
						{	throw error ?? new Error('Stream aborted');
						}
						return null;
					}
					else if (currentChunkResolve)
					{	const n = Math.min(currentChunk.byteLength, view.byteLength);
						view.set(currentChunk.subarray(0, n));
						currentChunkResolve(n);
						currentChunkResolve = undefined;
						return n;
					}
					else
					{	currentChunk = view;
						return new Promise((y, n) => {currentViewResolve=y; currentViewReject=n});
					}
				}
			}
		);
	}
}
