import {RdStream} from './rd_stream.ts';
import {WrStream, WrStreamInternal, Writer, WriteCallbackAccessor, _closeEvenIfLocked} from './wr_stream.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

export type Transformer =
{	// properties:

	/**	This callback is called immediately during `TrStream` object creation.
		When it's promise resolves, i start to call `transform()` to transform data chunks.
		Only one call is active at each moment, and next calls wait for previous calls to complete.

		When the whole input stream is converted without an error, `flush()` is called, as the last action.
		If `start()` or `transform()` throw error, this error is propagated to the output stream,
		and no more callbacks are called.
	 **/
	start?(writer: Writer): void | PromiseLike<void>;

	/**	During stream transformation this callback gets called for chunks (pieces) of incoming data.
		This callback is expected to transform the data as needed, and to write the result to a `writer`
		provided to it.
		Each input chunk can be of any non-zero size.
		If this callback cannot decide how to transform current chunk, and `canReturnZero` is true,
		it can return 0, and then this callback will be called again with a larger chunk,
		or the caller will discover that this was the last chunk, and next time will call
		`transform()` with the same chunk and `!canReturnZero`.
		In order to provide a larger chunk, the caller of this callback may be required to reallocate (grow) it's internal buffer.
	 **/
	transform(writer: Writer, chunk: Uint8Array, canReturnZero: boolean): number | PromiseLike<number>;

	/**	At last, when the whole stream was transformed, this callback is called.
	 **/
	flush?(writer: Writer): void | PromiseLike<void>;
};

const EMPTY_CHUNK = new Uint8Array;

enum UseCanReturnZero
{	YES, NO, UNKNOWN
}

export class TrStream extends TransformStream<Uint8Array, Uint8Array>
{	// properties:

	/**	Input for the original stream.
		All the bytes written here will be transformed by this object, and will be available for reading from `TrStream.readable`.
	 **/
	readonly writable: WrStream;

	/**	Outputs the transformed stream.
	 **/
	readonly readable: RdStream;

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
		let useCanReturnZero = UseCanReturnZero.UNKNOWN;
		let buffer = EMPTY_CHUNK;
		let bufferLen = 0;

		// Callbacks (`start()`, `transform()` and `flush()`) will write to this writer data that is about to be read by `this.readable`
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

					close: () =>
					{	// `transform()` called `writer.close()`
						isEof = true;
						currentChunk = EMPTY_CHUNK;
						currentViewResolve?.(null);
						currentViewResolve = undefined;
						currentViewReject = undefined;
						this.writable[_closeEvenIfLocked]();
					},

					abort: reason =>
					{	// `transform()` called `writer.abort()`
						isError = true;
						error = reason;
						isEof = true;
						currentChunk = EMPTY_CHUNK;
						currentViewReject?.(error);
						currentViewResolve = undefined;
						currentViewReject = undefined;
						this.writable.abort(reason);
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

		async function transformWithCanReturnZero(chunk: Uint8Array)
		{	if (bufferLen == 0)
			{	const n = await transform(writer, chunk, true);
				if (n != 0)
				{	return n;
				}
				bufferLen = chunk.byteLength;
				buffer = new Uint8Array(bufferLen * 2);
				buffer.set(chunk);
			}
			else
			{	let rest = EMPTY_CHUNK;
				// Assume: canReturnZeroBufferLen < canReturnZeroBuffer.byteLength
				if (bufferLen+chunk.byteLength <= buffer.byteLength)
				{	buffer.set(chunk, bufferLen);
					bufferLen += chunk.byteLength;
				}
				else
				{	const l = buffer.byteLength-bufferLen;
					buffer.set(chunk.subarray(0, l), bufferLen);
					bufferLen = buffer.byteLength;
					rest = chunk.subarray(l);
				}
				const n = await transform(writer, buffer.subarray(0, bufferLen), true);
				if (n != 0)
				{	buffer.copyWithin(0, n, bufferLen);
					bufferLen -= n;
					return chunk.byteLength - rest.byteLength;
				}
				const tmp = new Uint8Array((bufferLen + rest.byteLength) * 2);
				tmp.set(buffer.subarray(0, bufferLen));
				tmp.set(rest, bufferLen);
				bufferLen += rest.byteLength;
				buffer = tmp;
			}
			return chunk.byteLength;
		}

		// User (typically `pipeThrough()`) will write to here the original stream.
		// Data written to here is passed to `transform()` that is expected to call `writer.write()`.
		this.writable = new WrStreamInternal
		(	{	start: !start ? undefined : () => start(writer),

				write(chunk, canReturnZero)
				{	switch (useCanReturnZero)
					{	case UseCanReturnZero.YES:
							return transform(writer, chunk, canReturnZero);
						case UseCanReturnZero.NO:
							return transformWithCanReturnZero(chunk);
						default:
							if (canReturnZero)
							{	useCanReturnZero = UseCanReturnZero.YES;
								return transform(writer, chunk, canReturnZero);
							}
							else
							{	useCanReturnZero = UseCanReturnZero.NO;
								return transformWithCanReturnZero(chunk);
							}
					}
				},

				async close()
				{	// Input stream ended
					try
					{	while (bufferLen > 0)
						{	const n = await transform(writer, buffer.subarray(0, bufferLen), false);
							if (!(n > 0))
							{	throw new Error(`transform() returned 0 when there're no more data`);
							}
							buffer = buffer.subarray(n);
							bufferLen -= n;
						}
						await flush?.(writer);
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
		this.readable = new RdStream
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
