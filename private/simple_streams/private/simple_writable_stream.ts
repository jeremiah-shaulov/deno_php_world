import {DEFAULT_AUTO_ALLOCATE_SIZE, CallbackStart, CallbackReadOrWrite, CallbackWrite, CallbackClose, CallbackCancelOrAbort, CallbackAccessor, ReaderOrWriter} from './common.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

export type Sink =
{	start?: CallbackStart;
	write: CallbackWrite;
	close?: CallbackClose;
	abort?: CallbackCancelOrAbort;
};

export class SimpleWritableStream extends WritableStream<Uint8Array>
{	#callbackAccessor: CallbackAccessor;
	#locked = false;
	#writerRequests = new Array<(writer: WritableStreamDefaultWriter<Uint8Array>) => void>;

	constructor(sink: Sink)
	{	super();
		this.#callbackAccessor = new CallbackAccessor(0, 0, sink.start, sink.write, sink.close, sink.abort);
	}

	get locked()
	{	return this.#locked;
	}

	abort(reason?: Any)
	{	if (this.#locked)
		{	throw new Error('This stream is locked');
		}
		return this.#callbackAccessor.cancelOrAbort(reason);
	}

	close()
	{	if (this.#locked)
		{	throw new Error('This stream is locked');
		}
		return this.#callbackAccessor.close();
	}

	getWriter(): WritableStreamDefaultWriter<Uint8Array>
	{	if (this.#locked)
		{	throw new Error('This stream is locked');
		}
		this.#locked = true;
		return new Writer
		(	this.#callbackAccessor,
			() =>
			{	this.#locked = false;
				const y = this.#writerRequests.pop();
				if (y)
				{	y(this.getWriter());
				}
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
	{	const reader = this.getWriter();
		try
		{	const nWritten = await this.#callbackAccessor.write(chunk);
			if (nWritten == null)
			{	throw new Error('This writer is closed');
			}
			return nWritten;
		}
		finally
		{	reader.releaseLock();
		}
	}

	async writeAll(chunk: Uint8Array)
	{	const reader = this.getWriter();
		try
		{	await reader.write(chunk);
		}
		finally
		{	reader.releaseLock();
		}
	}
}

export class Writer extends ReaderOrWriter
{	#desiredSize = DEFAULT_AUTO_ALLOCATE_SIZE;

	get desiredSize()
	{	return this.#desiredSize;
	}

	get ready(): Promise<void>
	{	return this.callbackAccessor?.ongoing ?? Promise.resolve();
	}

	async write(chunk: Uint8Array)
	{	this.#desiredSize = 0;
		while (chunk.byteLength > 0)
		{	const nWritten = await this.getCallbackAccessor().write(chunk);
			if (nWritten == null)
			{	throw new Error('This writer is closed');
			}
			chunk = chunk.subarray(nWritten);
		}
		this.#desiredSize = DEFAULT_AUTO_ALLOCATE_SIZE; // if i don't reach this line of code, the `desiredSize` will remain `0`
	}

	/**	@internal
	 **/
	async useLowLevelCallback<T>(callback: (callbackWrite: CallbackReadOrWrite) => T | PromiseLike<T>)
	{	this.#desiredSize = 0;
		await this.getCallbackAccessor().useCallback(callback);
		this.#desiredSize = DEFAULT_AUTO_ALLOCATE_SIZE; // if i don't reach this line of code, the `desiredSize` will remain `0`
	}

	close(): Promise<void>
	{	return this.getCallbackAccessor().close();
	}

	abort(reason?: Any)
	{	return this.getCallbackAccessor().cancelOrAbort(reason);
	}
}
