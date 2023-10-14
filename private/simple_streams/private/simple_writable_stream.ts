import {DEFAULT_AUTO_ALLOCATE_SIZE, CallbackAccessor, ReaderOrWriter} from './common.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

type CallbackStart = () => void | PromiseLike<void>;
type CallbackWrite = (chunk: Uint8Array) => number | PromiseLike<number>;
type CallbackClose = () => void | PromiseLike<void>;
type CallbackAbort = (reason: Any) => void | PromiseLike<void>;

export type Sink =
{	start?: CallbackStart;
	write: CallbackWrite;
	close?: CallbackClose;
	abort?: CallbackAbort;
};

export class SimpleWritableStream extends WritableStream<Uint8Array>
{	#callbackAccessor: WriteCallbackAccessor;
	#locked = false;
	#writerRequests = new Array<(writer: WritableStreamDefaultWriter<Uint8Array>) => void>;

	constructor(sink: Sink)
	{	const callbackAccessor = new WriteCallbackAccessor(sink.start, sink.write, sink.close, sink.abort);
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

	abort(reason?: Any)
	{	if (this.#locked)
		{	throw new TypeError('WritableStream is locked.');
		}
		return this.#callbackAccessor.close(true, reason);
	}

	close()
	{	if (this.#locked)
		{	throw new TypeError('WritableStream is locked.');
		}
		return this.#callbackAccessor.close();
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

	async write(chunk: Uint8Array)
	{	const writer = this.getWriter();
		try
		{	const nWritten = await this.#callbackAccessor.write(chunk);
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

export class WriteCallbackAccessor extends CallbackAccessor<number>
{	write(chunk: Uint8Array)
	{	return this.useCallback(callbackWrite => callbackWrite(chunk));
	}

	writeAll(chunk: Uint8Array)
	{	return this.useCallback
		(	callbackWrite =>
			{	while (chunk.byteLength > 0)
				{	const resultOrPromise = callbackWrite(chunk);
					if (typeof(resultOrPromise) == 'number')
					{	chunk = chunk.subarray(resultOrPromise);
					}
					else
					{	return resultOrPromise.then
						(	async nWritten =>
							{	chunk = chunk.subarray(nWritten);
								while (chunk.byteLength > 0)
								{	nWritten = await callbackWrite(chunk);
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
	async useLowLevelCallback<T>(callback: (callbackWrite: CallbackWrite) => T | PromiseLike<T>)
	{	this.#desiredSize = 0;
		const result = await this.getCallbackAccessor().useCallback(callback);
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
