import {DEFAULT_AUTO_ALLOCATE_SIZE, Callbacks, CallbackAccessor, ReaderOrWriter} from './common.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

export const _closeEvenIfLocked = Symbol('_closeEvenIfLocked');

export type Sink =
{	/**	This callback is called immediately during `WrStream` object creation.
		When it's promise resolves, i start to call `write()` as response to `writer.write()`.
		Only one call is active at each moment, and next calls wait for previous calls to complete.

		At the end one of `close()`, `abort(reason)` or `catch(error)` is called.
		- `close()` if caller called `writer.close()` to terminate the stream.
		- `abort()` if caller called `wrStream.abort(reason)` or `writer.abort(reason)`.
		- `catch()` if `write()` thrown exception or returned a rejected promise.
	 **/
	start?(): void | PromiseLike<void>;

	/**	WrStream calls this callback to ask it to write a chunk of data to the destination that it's managing.
	 **/
	write(chunk: Uint8Array, canRedo: boolean): number | PromiseLike<number>;
	close?(): void | PromiseLike<void>;
	abort?(reason: Any): void | PromiseLike<void>;
	catch?(reason: Any): void | PromiseLike<void>;
};

export class WrStream extends WritableStream<Uint8Array>
{	#callbackAccessor: WriteCallbackAccessor;
	#locked = false;
	#writerRequests = new Array<(writer: WritableStreamDefaultWriter<Uint8Array>) => void>;

	constructor(sink: Sink)
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

	get locked()
	{	return this.#locked;
	}

	getWriter(): WritableStreamDefaultWriter<Uint8Array>
	{	if (this.#locked)
		{	throw new TypeError('WritableStream is locked.');
		}
		this.#locked = true;
		return new Writer
		(	this.#callbackAccessor,
			() =>
			{	this.#locked = false;
				const y = this.#writerRequests.pop();
				y?.(this.getWriter());
			}
		);
	}

	getWriterWhenReady()
	{	if (!this.#locked)
		{	return Promise.resolve(this.getWriter());
		}
		return new Promise<WritableStreamDefaultWriter<Uint8Array>>(y => {this.#writerRequests.push(y)});
	}

	/**	Can be aborted even if locked.
	 **/
	abort(reason?: Any)
	{	return this.#callbackAccessor.close(true, reason);
	}

	close()
	{	if (this.#locked)
		{	throw new TypeError('WritableStream is locked.');
		}
		return this.#callbackAccessor.close();
	}

	[_closeEvenIfLocked]()
	{	return this.#callbackAccessor.close();
	}

	async write(chunk: Uint8Array)
	{	const writer = this.getWriter();
		try
		{	const nWritten = await this.#callbackAccessor.useCallbacks(callbacks => callbacks.write!(chunk, false));
			if (nWritten == undefined)
			{	throw new Error('This writer is closed');
			}
			return nWritten;
		}
		finally
		{	writer.releaseLock();
		}
	}

	async writeAll(chunk: Uint8Array)
	{	const writer = this.getWriter();
		try
		{	await this.#callbackAccessor.writeAll(chunk);
		}
		finally
		{	writer.releaseLock();
		}
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

	async write(chunk: Uint8Array)
	{	this.#desiredSize = 0;
		await this.getCallbackAccessor().writeAll(chunk);
		this.#desiredSize = DEFAULT_AUTO_ALLOCATE_SIZE; // if i don't reach this line of code, the `desiredSize` must remain `0`
	}

	/**	@internal
	 **/
	async useLowLevelCallbacks<T>(callbacks: (callbacks: Callbacks) => T | PromiseLike<T>)
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