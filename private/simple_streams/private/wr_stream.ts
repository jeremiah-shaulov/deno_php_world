import {DEFAULT_AUTO_ALLOCATE_SIZE, Callbacks, CallbackAccessor, ReaderOrWriter} from './common.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

export const _closeEvenIfLocked = Symbol('_closeEvenIfLocked');
export const _useLowLevelCallbacks = Symbol('_useLowLevelCallbacks');

type SinkInternal =
{	start?(): void | PromiseLike<void>;
	write(chunk: Uint8Array, canReturnZero: boolean): number | PromiseLike<number>;
	close?(): void | PromiseLike<void>;
	abort?(reason: Any): void | PromiseLike<void>;
	catch?(reason: Any): void | PromiseLike<void>;
};

export type Sink =
{	// properties:

	/**	This callback is called immediately during `WrStream` object creation.
		When it's promise resolves, i start to call `write()` as response to `writer.write()`.
		Only one call is active at each moment, and next calls wait for previous calls to complete.

		At the end one of `close()`, `abort(reason)` or `catch(error)` is called.
		- `close()` if caller called `writer.close()` to terminate the stream.
		- `abort()` if caller called `wrStream.abort(reason)` or `writer.abort(reason)`.
		- `catch()` if `write()` thrown exception or returned a rejected promise.
	 **/
	start?(): void | PromiseLike<void>;

	/**	WrStream calls this callback to ask it to write a chunk of data to the destination that it's managing.
		The callback can process the writing completely or partially, and it must return number of bytes processed
		(how many bytes from the beginning of the chunk are written).
		If it processed only a part, the rest of the chunk, and probably additional bytes,
		will be passed to the next call to `write()`.
		This callback must not return 0.
	 **/
	write(chunk: Uint8Array): number | PromiseLike<number>;

	/**	This method is called as response to `writer.close()`.
		After that, no more callbacks are called.
	 **/
	close?(): void | PromiseLike<void>;

	/**	This method is called as response to `wrStream.abort(reason)` or `writer.abort(reason)`.
		After that, no more callbacks are called.
	 **/
	abort?(reason: Any): void | PromiseLike<void>;

	/**	This method is called when {@link Sink.write} thrown exception or returned a rejected promise.
		After that, no more callbacks are called.
	 **/
	catch?(reason: Any): void | PromiseLike<void>;
};

export class WrStreamInternal extends WritableStream<Uint8Array>
{	#callbackAccessor: WriteCallbackAccessor;
	#locked = false;
	#writerRequests = new Array<(writer: WritableStreamDefaultWriter<Uint8Array> & Writer) => void>;

	constructor(sink: SinkInternal)
	{	const callbackAccessor = new WriteCallbackAccessor(sink, true);
		super
		(	// `deno_web/06_streams.js` uses hackish way to call methods of `WritableStream` subclasses.
			// When this class is being used like this, the following callbacks are called:
			{	write(chunk)
				{	return callbackAccessor.writeAll(chunk);
				},

				close()
				{	return callbackAccessor.close();
				},

				abort(reason)
				{	return callbackAccessor.close(true, reason);
				}
			}
		);
		this.#callbackAccessor = callbackAccessor;
	}

	/**	When somebody wants to start writing to this stream, he calls `wrStream.getWriter()`, and after that call the stream becomes locked.
		Future calls to `wrStream.getWriter()` will throw error till the writer is released (`writer.releaseLock()`).

		Other operations that write to the stream (like `wrStream.writeAll()`) also lock it (internally they get writer, and release it later).
	 **/
	get locked()
	{	return this.#locked;
	}

	/**	Returns object that allows to write data to the stream.
		The stream becomes locked till this writer is released by calling `writer.releaseLock()` or `writer[Symbol.dispose]()`.

		If the stream is already locked, this method throws error.
	 **/
	getWriter(): WritableStreamDefaultWriter<Uint8Array> & Writer
	{	if (this.#locked)
		{	throw new TypeError('WritableStream is locked.');
		}
		this.#locked = true;
		return new Writer
		(	this.#callbackAccessor,
			() =>
			{	this.#locked = false;
				const y = this.#writerRequests.shift();
				y?.(this.getWriter());
			}
		);
	}

	/**	Like `wrStream.getWriter()`, but waits for the stream to become unlocked before returning the writer (and so locking it again).
	 **/
	getWriterWhenReady()
	{	if (!this.#locked)
		{	return Promise.resolve(this.getWriter());
		}
		return new Promise<WritableStreamDefaultWriter<Uint8Array> & Writer>(y => {this.#writerRequests.push(y)});
	}

	/**	Interrupt current writing operation (reject the promise that `writer.write()` returned, if any),
		and set the stream to error state.
		This leads to calling `sink.abort(reason)`, even if current `sink.write()` didn't finish.
		`sink.abort()` is expected to interrupt or complete all the current operations,
		and finalize the sink, as no more callbacks will be called.

		In contrast to `WritableStream.abort()`, this method works even if the stream is locked.
	 **/
	abort(reason?: Any)
	{	return this.#callbackAccessor.close(true, reason);
	}

	/**	Calls `sink.close()`. After that no more callbacks will be called.
	 **/
	close()
	{	if (this.#locked)
		{	throw new TypeError('WritableStream is locked.');
		}
		return this.#callbackAccessor.close();
	}

	[_closeEvenIfLocked]()
	{	return this.#callbackAccessor.close();
	}

	/**	Waits for the stream to be unlocked, gets writer (locks the stream),
		writes the chunk, and then releases the writer (unlocks the stream).
		This is the same as doing:
		```ts
		{	using writer = await wrStream.getWriterWhenReady();
			await writer.write(chunk);
		}
		```
	 **/
	async writeWhenReady(chunk: Uint8Array)
	{	const writer = await this.getWriterWhenReady();
		try
		{	await this.#callbackAccessor.writeAll(chunk);
		}
		finally
		{	writer.releaseLock();
		}
	}
}

export class WrStream extends WrStreamInternal
{	constructor(sink: Sink)
	{	super(sink);
	}
}

export class WriteCallbackAccessor extends CallbackAccessor
{	writeAll(chunk: Uint8Array)
	{	return this.useCallbacks
		(	callbacks =>
			{	while (chunk.byteLength > 0)
				{	const resultOrPromise = callbacks.write!(chunk, false);
					if (typeof(resultOrPromise) == 'number')
					{	if (resultOrPromise == 0)
						{	throw new Error('write() returned 0 during writeAll()');
						}
						chunk = chunk.subarray(resultOrPromise);
					}
					else
					{	return resultOrPromise.then
						(	async nWritten =>
							{	if (nWritten == 0)
								{	throw new Error('write() returned 0 during writeAll()');
								}
								chunk = chunk.subarray(nWritten);
								while (chunk.byteLength > 0)
								{	nWritten = await callbacks.write!(chunk, false);
									if (nWritten == 0)
									{	throw new Error('write() returned 0 during writeAll()');
									}
									chunk = chunk.subarray(nWritten);
								}
							}
						);
					}
				}
			}
		);
	}
}

export class Writer extends ReaderOrWriter<WriteCallbackAccessor>
{	#desiredSize = DEFAULT_AUTO_ALLOCATE_SIZE;

	get desiredSize()
	{	return this.#desiredSize;
	}

	get ready()
	{	return this.callbackAccessor?.ready ?? Promise.resolve();
	}

	/**	Writes the chunk by calling `sink.write()`
		till the whole chunk is written (if `sink.write()` returns `0`, throws error).
	 **/
	async write(chunk: Uint8Array)
	{	this.#desiredSize = 0;
		await this.getCallbackAccessor().writeAll(chunk);
		this.#desiredSize = DEFAULT_AUTO_ALLOCATE_SIZE; // if i don't reach this line of code, the `desiredSize` must remain `0`
	}

	async [_useLowLevelCallbacks]<T>(callbacks: (callbacks: Callbacks) => T | PromiseLike<T>)
	{	this.#desiredSize = 0;
		const result = await this.getCallbackAccessor().useCallbacks(callbacks);
		this.#desiredSize = DEFAULT_AUTO_ALLOCATE_SIZE; // if i don't reach this line of code, the `desiredSize` must remain `0`
		return result;
	}

	close(): Promise<void>
	{	return this.getCallbackAccessor().close();
	}

	abort(reason?: Any)
	{	return this.getCallbackAccessor().close(true, reason);
	}
}
