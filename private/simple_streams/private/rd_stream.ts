import {DEFAULT_AUTO_ALLOCATE_SIZE, Callbacks, CallbackAccessor, ReaderOrWriter} from './common.ts';
import {Writer, _useLowLevelCallbacks} from './wr_stream.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

export type Source =
{	// properties:

	/**	When auto-allocating (reading in non-byob mode) will pass to {@link Source.read} buffers of at most this size.
		If undefined or non-positive number, a predefined default value (like 32 KiB) is used.
	 **/
	autoAllocateChunkSize?: number;

	/**	When auto-allocating (reading in non-byob mode) will not call `read()` with buffers smaller than this.
		First i'll allocate `autoAllocateChunkSize` bytes, and if `read()` callback fills in only a small part of them
		(so there're >= `autoAllocateMin` unused bytes in the buffer), i'll reuse that part of the buffer in next `read()` calls.
	 **/
	autoAllocateMin?: number;

	/**	This callback is called immediately during `RdStream` object creation.
		When it's promise resolves, i start to call `read()` to pull data as response to `reader.read()`.
		Only one call is active at each moment, and next calls wait for previous calls to complete.

		At the end one of `close()`, `cancel(reason)` or `catch(error)` is called.
		- `close()` is called if `read()` returned EOF (`0` or `null`).
		- `cancel()` if caller called `rdStream.cancel(reason)` or `reader.cancel(reason)`.
		- `catch()` if `read()` thrown exception or returned a rejected promise.
	 **/
	start?(): void | PromiseLike<void>;

	/**	This method is called to pull data from input source to a Uint8Array object provied to it.
		The object provided is never empty.
		The function is expected to load available data to the view, and to return number of bytes loaded.
		On EOF it's expected to return `0` or `null`.
		This callback is called as response to user request for data, and it's never called before such request.
	 **/
	read(view: Uint8Array): number | null | PromiseLike<number|null>;

	/**	This method is called when {@link Source.read} returns `0` or `null` that indicate EOF.
		After that, no more callbacks are called (except `catch()`).
		If you use `Deno.Reader & Deno.Closer` as source, that source will be closed when read to the end without error.
	 **/
	close?(): void | PromiseLike<void>;

	/**	Is called as response to `rdStream.cancel()` or `reader.cancel()`.
		After that, no more callbacks are called (except `catch()`).
	 **/
	cancel?(reason: Any): void | PromiseLike<void>;

	/**	Is called when `start()`, `read()`, `close()` or `cancel()` thrown exception or returned a rejected promise.
		After that, no more callbacks are called.
	 **/
	catch?(reason: Any): void | PromiseLike<void>;
};

/**	This class extends `ReadableStream<Uint8Array>`, and can be used as it's substitutor.
	It has the following differences:

	- Source is defined with `Deno.Reader`-compatible object.
	- No controllers concept.
	- BYOB-agnostic. Data consumer can use BYOB or regular reading mode, and there's no need of handling these situations differently.
	- No transferring buffers that you pass to `reader.read(buffer)`, so the buffers remain usable after the call.
 **/
export class RdStream extends ReadableStream<Uint8Array>
{	// static:

	/**	Constructs `RdStream` from an iterable of `Uint8Array`.
		Note that `ReadableStream<Uint8Array>` is also iterable of `Uint8Array`, so it can be converted to `RdStream`,
		and the resulting `RdStream` will be a wrapper on it.

		If you have data source that implements both `ReadableStream<Uint8Array>` and `Deno.Reader`, it's more efficient to create wrapper from `Deno.Reader`
		by calling the `RdStream` constructor.

		```ts
		// Create from `Deno.Reader`. This is preferred.
		const file1 = await Deno.open('/etc/passwd');
		const rdStream1 = new RdStream(file1); // `file1` is `Deno.Reader`
		console.log(await rdStream1.text());

		// Create from `ReadableStream<Uint8Array>`.
		const file2 = await Deno.open('/etc/passwd');
		const rdStream2 = RdStream.from(file2.readable); // `file2.readable` is `ReadableStream<Uint8Array>`
		console.log(await rdStream2.text());
		```
	 **/
	static from<R>(source: AsyncIterable<R> | Iterable<R | PromiseLike<R>>): ReadableStream<R> & RdStream
	{	if (source instanceof RdStream)
		{	return source as Any;
		}
		else if (source instanceof ReadableStream)
		{	let readerInUse: ReadableStreamBYOBReader | ReadableStreamDefaultReader<unknown> | undefined;
			let innerRead: ((view: Uint8Array) => Promise<number>) | undefined;
			return new RdStream
			(	{	read(view)
					{	if (!innerRead)
						{	try
							{	// Try BYOB
								const reader = source.getReader({mode: 'byob'});
								readerInUse = reader;
								let buffer = new Uint8Array(DEFAULT_AUTO_ALLOCATE_SIZE);
								innerRead = async view =>
								{	try
									{	const {value, done} = await reader.read(buffer.subarray(0, Math.min(view.byteLength, buffer.byteLength)));
										if (done)
										{	reader.releaseLock();
										}
										if (value)
										{	view.set(value);
											buffer = new Uint8Array(value.buffer);
											return value.byteLength;
										}
										return 0;
									}
									catch (e)
									{	reader.releaseLock();
										throw e;
									}
								};
							}
							catch
							{	// BYOB failed, so use default
								const reader = source.getReader();
								readerInUse = reader;
								let buffer: Uint8Array|undefined;
								innerRead = async view =>
								{	try
									{	if (!buffer)
										{	const {value, done} = await reader.read();
											if (done)
											{	reader.releaseLock();
												return 0;
											}
											if (!(value instanceof Uint8Array))
											{	throw new Error('Must be async iterator of Uint8Array');
											}
											buffer = value;
										}
										const haveLen = buffer.byteLength;
										const askedLen = view.byteLength;
										if (haveLen <= askedLen)
										{	view.set(buffer);
											buffer = undefined;
											return haveLen;
										}
										else
										{	view.set(buffer.subarray(0, askedLen));
											buffer = buffer.subarray(askedLen);
											return askedLen;
										}
									}
									catch (e)
									{	reader.releaseLock();
										throw e;
									}
								};
							}
						}
						return innerRead(view);
					},
					cancel(reason)
					{	return (readerInUse ?? source).cancel(reason);
					}
				}
			) as Any;
		}
		else if (Symbol.asyncIterator in source)
		{	const it = source[Symbol.asyncIterator]();
			let buffer: Uint8Array|undefined;
			return new RdStream
			(	{	async read(view)
					{	if (!buffer)
						{	const {value, done} = await it.next();
							if (done)
							{	return null;
							}
							if (!(value instanceof Uint8Array))
							{	throw new Error('Must be async iterator of Uint8Array');
							}
							buffer = value;
						}
						const haveLen = buffer.byteLength;
						const askedLen = view.byteLength;
						if (haveLen <= askedLen)
						{	view.set(buffer);
							buffer = undefined;
							return haveLen;
						}
						else
						{	view.set(buffer.subarray(0, askedLen));
							buffer = buffer.subarray(askedLen);
							return askedLen;
						}
					},
					async cancel()
					{	await it.return?.();
					}
				}
			) as Any;
		}
		else if (Symbol.iterator in source)
		{	const it = source[Symbol.iterator]();
			let buffer: Uint8Array|undefined;
			return new RdStream
			(	{	async read(view)
					{	if (!buffer)
						{	const {value, done} = it.next();
							if (done)
							{	return null;
							}
							const valueValue = await value;
							if (!(valueValue instanceof Uint8Array))
							{	throw new Error('Must be iterator of Uint8Array or Promise<Uint8Array>');
							}
							buffer = valueValue;
						}
						const haveLen = buffer.byteLength;
						const askedLen = view.byteLength;
						if (haveLen <= askedLen)
						{	view.set(buffer);
							buffer = undefined;
							return haveLen;
						}
						else
						{	view.set(buffer.subarray(0, askedLen));
							buffer = buffer.subarray(askedLen);
							return askedLen;
						}
					},
					cancel()
					{	it.return?.();
					}
				}
			) as Any;
		}
		else
		{	throw new Error('Invalid argument');
		}
	}

	// properties:

	#callbackAccessor: ReadCallbackAccessor;
	#locked = false;
	#readerRequests = new Array<(reader: (ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader) & Reader) => void>;

	/**	When somebody wants to start reading this stream, he calls `rdStream.getReader()`, and after that call the stream becomes locked.
		Future calls to `rdStream.getReader()` will throw error till the reader is released (`reader.releaseLock()`).

		Other operations that read the stream (like `rdStream.pipeTo()`) also lock it (internally they get reader, and release it later).
	 **/
	get locked()
	{	return this.#locked;
	}

	// constructor:

	constructor(source: Source)
	{	super();
		const autoAllocateChunkSizeU = source.autoAllocateChunkSize;
		const autoAllocateMinU = source.autoAllocateMin;
		const autoAllocateChunkSize = autoAllocateChunkSizeU && autoAllocateChunkSizeU>0 ? autoAllocateChunkSizeU : DEFAULT_AUTO_ALLOCATE_SIZE;
		const autoAllocateMin = Math.min(autoAllocateChunkSize, autoAllocateMinU && autoAllocateMinU>0 ? autoAllocateMinU : Math.max(256, autoAllocateChunkSize >> 3));
		this.#callbackAccessor = new ReadCallbackAccessor(autoAllocateChunkSize, autoAllocateMin, source);
	}

	// methods:

	/**	Returns object that allows to read data from the stream.
		The stream becomes locked till this reader is released by calling `reader.releaseLock()` or `reader[Symbol.dispose]()`.

		If the stream is already locked, this method throws error.
	 **/
	getReader(options?: {mode?: undefined}): ReadableStreamDefaultReader<Uint8Array> & Reader;
	getReader(options: {mode: 'byob'}): ReadableStreamBYOBReader & Reader;
	getReader(_options?: {mode?: 'byob'}): (ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader) & Reader
	{	if (this.#locked)
		{	throw new TypeError('ReadableStream is locked.');
		}
		this.#locked = true;
		return new Reader
		(	this.#callbackAccessor,
			() =>
			{	this.#locked = false;
				const y = this.#readerRequests.shift();
				if (y)
				{	y(this.getReader());
				}
			}
		);
	}

	/**	Like `rdStream.getReader()`, but waits for the stream to become unlocked before returning the reader (and so locking it again).
	 **/
	getReaderWhenReady(options?: {mode?: undefined}): Promise<ReadableStreamDefaultReader<Uint8Array> & Reader>;
	getReaderWhenReady(options: {mode: 'byob'}): Promise<ReadableStreamBYOBReader & Reader>;
	getReaderWhenReady(_options?: {mode?: 'byob'}): Promise<(ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader) & Reader>
	{	if (!this.#locked)
		{	return Promise.resolve(this.getReader());
		}
		return new Promise<(ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader) & Reader>(y => {this.#readerRequests.push(y)});
	}

	/**	Interrupt current reading operation (reject the promise that `reader.read()` returned, if any),
		and tell to discard further data in the stream.
		This leads to calling `source.cancel(reason)`, even if current `source.read()` didn't finish.
		`source.cancel()` must implement the actual behavior on how to discard further data,
		and finalize the source, as no more callbacks will be called.

		In contrast to `ReadableStream.cancel()`, this method works even if the stream is locked.
	 **/
	cancel(reason?: Any)
	{	return this.#callbackAccessor.close(true, reason);
	}

	/**	Allows to iterate this stream yielding `Uint8Array` data chunks.

		Usually you want to use `for await...of` to iterate.
		```ts
		for await (const chunk of rdStream)
		{	// ...
		}
		```
		It's also possible to iterate manually. In this case you need to be "using" the iterator, or to call `releaseLock()` explicitly.
		```ts
		using it = rdStream.values();
		while (true)
		{	const {value, done} = await it.next();
			if (done)
			{	break;
			}
			// ...
		}
		```

		If the stream is locked, this method throws error. However you can do `getReaderWhenReady()`, and call identical method on the reader.
	 **/
	[Symbol.asyncIterator](options?: {preventCancel?: boolean})
	{	return new ReadableStreamIterator(this.getReader(), options?.preventCancel===true);
	}

	/**	This function is the same as `this[Symbol.asyncIterator]`.
		It allows to iterate this stream yielding `Uint8Array` data chunks.

		Usually you want to use `for await...of` to iterate.
		```ts
		for await (const chunk of rdStream.values())
		{	// ...
		}
		```
		It's also possible to iterate manually. In this case you need to be "using" the iterator, or to call `releaseLock()` explicitly.
		```ts
		using it = rdStream.values();
		while (true)
		{	const {value, done} = await it.next();
			if (done)
			{	break;
			}
			// ...
		}
		```

		If the stream is locked, this method throws error. However you can do `getReaderWhenReady()`, and call identical method on the reader.
	 **/
	values(options?: {preventCancel?: boolean})
	{	return new ReadableStreamIterator(this.getReader(), options?.preventCancel===true);
	}

	/**	Splits the stream to 2, so the rest of the data can be read from both of the resulting streams.

		If you'll read from one stream faster than from another, or will not read at all from one of them,
		the default behavior is to buffer the data.

		If `requireParallelRead` option is set, the buffering will be disabled,
		and parent stream will suspend after each item, till it's read by both of the child streams.
		In this case if you read and await from the first stream, without previously starting reading from the second,
		this will cause a deadlock situation.

		If the stream is locked, this method throws error. However you can do `getReaderWhenReady()`, and call identical method on the reader.
	 **/
	tee(options?: {requireParallelRead?: boolean}): [RdStream, RdStream]
	{	return this.getReader().tee(options);
	}

	/**	Pipe data from this stream to `dest` writable stream (that can be built-in `WritableStream<Uint8Array>` or `WrStream`).

		If the data is piped to EOF without error, the source readable stream is closed as usual (`close()` callback is called on `Source`),
		and the writable stream will be closed unless `preventClose` option is set.

		If destination closes or enters error state, then `pipeTo()` throws exception.
		But then `pipeTo()` can be called again to continue piping the rest of the stream to another destination (including previously buffered data).

		If the stream is locked, this method throws error. However you can do `getReaderWhenReady()`, and call identical method on the reader.
	 **/
	pipeTo(dest: WritableStream<Uint8Array>, options?: PipeOptions)
	{	return this.getReader().pipeTo(dest, options);
	}

	/**	Uses `rdStream.pipeTo()` to pipe the data to transformer's writable stream, and returns transformer's readable stream.

		The transformer can be an instance of built-in `TransformStream<Uint8Array, unknown>`, `TrStream`, or any other `writable/readable` pair.

		If the stream is locked, this method throws error. However you can do `getReaderWhenReady()`, and call identical method on the reader.
	 **/
	pipeThrough<T, W extends WritableStream<Uint8Array>, R extends ReadableStream<T>>
	(	transform:
		{	readonly writable: W;
			readonly readable: R;
		},
		options?: PipeOptions
	)
	{	return this.getReader().pipeThrough(transform, options);
	}

	/**	Reads the whole stream to memory.

		If the stream is locked, this method throws error. However you can do `getReaderWhenReady()`, and call identical method on the reader.
	 **/
	uint8Array()
	{	return this.getReader().uint8Array();
	}

	/**	Reads the whole stream to memory, and converts it to string, just as `TextDecoder.decode()` does.

		If the stream is locked, this method throws error. However you can do `getReaderWhenReady()`, and call identical method on the reader.
	 **/
	text(label?: string, options?: TextDecoderOptions)
	{	return this.getReader().text(label, options);
	}
}

class ReadCallbackAccessor extends CallbackAccessor
{	curPiper: Piper|undefined;

	#autoAllocateBuffer: Uint8Array|undefined;

	constructor
	(	public autoAllocateChunkSize: number,
		public autoAllocateMin: number,
		callbacks: Callbacks,
	)
	{	super(callbacks, false);
	}

	read(view?: Uint8Array)
	{	if (view?.byteLength === 0)
		{	throw new Error('Empty BYOB buffer passed to read()');
		}
		return this.useCallbacks
		(	async callbacks =>
			{	let isUserSuppliedBuffer = true;
				if (!view)
				{	view = this.#autoAllocateBuffer ?? new Uint8Array(this.autoAllocateChunkSize);
					this.#autoAllocateBuffer = undefined;
					isUserSuppliedBuffer = false;
				}
				const {curPiper} = this;
				if (curPiper)
				{	const nRead = curPiper.read(view);
					if (nRead)
					{	return nRead;
					}
					this.curPiper = undefined;
				}
				const nRead = await callbacks.read!(view);
				if (!isUserSuppliedBuffer)
				{	const end = view.byteOffset + (nRead ?? 0);
					if (view.buffer.byteLength-end >= this.autoAllocateMin)
					{	this.#autoAllocateBuffer = new Uint8Array(view.buffer, end);
					}
				}
				if (!nRead)
				{	await this.close();
				}
				else
				{	return view.subarray(0, nRead);
				}
			}
		);
	}
}

/**	This class plays the same role in `RdStream` as does `ReadableStreamBYOBReader` in `ReadableStream<Uint8Array>`.
 **/
export class Reader extends ReaderOrWriter<ReadCallbackAccessor>
{	read(): Promise<ReadableStreamDefaultReadResult<Uint8Array>>;
	read<V extends ArrayBufferView>(view: V): Promise<ReadableStreamBYOBReadResult<V>>;
	async read<V extends ArrayBufferView>(view?: V): Promise<ReadableStreamBYOBReadResult<V>>
	{	if (view && !(view instanceof Uint8Array))
		{	throw new Error('Only Uint8Array is supported'); // i always return `Uint8Array`, and it must be also `V`
		}
		const view2 = await this.getCallbackAccessor().read(view);
		return {
			value: !view2 ? view?.subarray(0, 0) : view2 as Any,
			done: !view2,
		};
	}

	cancel(reason?: Any)
	{	return this.getCallbackAccessor().close(true, reason);
	}

	/**	Allows you to iterate this stream yielding `Uint8Array` data chunks.
	 **/
	[Symbol.asyncIterator](options?: {preventCancel?: boolean})
	{	return new ReadableStreamIterator(this, options?.preventCancel===true);
	}

	/**	Allows you to iterate this stream yielding `Uint8Array` data chunks.
	 **/
	values(options?: {preventCancel?: boolean})
	{	return new ReadableStreamIterator(this, options?.preventCancel===true);
	}

	/**	Splits the stream to 2, so the rest of the data can be read from both of the resulting streams.

		If you'll read from one stream faster than from another, or will not read at all from one of them,
		the default behavior is to buffer the data.

		If `requireParallelRead` option is set, the buffering will be disabled,
		and parent stream will suspend after each item, till it's read by both of the child streams.
		In this case if you read and await from the first stream, without previously starting reading from the second,
		this will cause a deadlock situation.
	 **/
	tee(options?: {requireParallelRead?: boolean}): [RdStream, RdStream]
	{	const tee = options?.requireParallelRead ? new TeeRequireParallelRead(this) : new TeeRegular(this);

		return [
			new RdStream
			(	{	read: view => tee.read(view, -1),
					cancel: reason => tee.cancel(reason, -1),
				}
			),
			new RdStream
			(	{	read: view => tee.read(view, +1),
					cancel: reason => tee.cancel(reason, +1),
				}
			),
		];
	}

	/**	Pipe data from this stream to `dest` writable stream (that can be built-in `WritableStream<Uint8Array>` or `WrStream`).

		If the data is piped to EOF without error, the source readable stream is closed as usual (`close()` callback is called on `Source`),
		and the writable stream will be closed unless `preventClose` option is set.

		If destination closes or enters error state, then `pipeTo()` throws exception.
		But then `pipeTo()` can be called again to continue piping the rest of the stream to another destination (including previously buffered data).

		Finally the reader will be unlocked.
	 **/
	async pipeTo(dest: WritableStream<Uint8Array>, options?: PipeOptions)
	{	try
		{	const callbackAccessor = this.getCallbackAccessor();
			const writer = dest.getWriter();
			const curPiper = callbackAccessor.curPiper ?? new Piper(callbackAccessor.autoAllocateChunkSize, callbackAccessor.autoAllocateMin);
			callbackAccessor.curPiper = curPiper;
			try
			{	const signal = options?.signal;
				if (signal)
				{	if (signal.aborted)
					{	throw signal.reason;
					}
					signal.addEventListener('abort', () => {writer.abort(signal.reason)});
				}
				const isEof = await callbackAccessor.useCallbacks
				(	callbacksForRead =>
					{	if (writer instanceof Writer)
						{	return writer[_useLowLevelCallbacks]
							(	callbacksForWrite => curPiper.pipeTo
								(	writer.closed,
									callbacksForRead,
									(chunk, canReturnZero) =>
									{	const resultOrPromise = callbacksForWrite.write!(chunk, canReturnZero);
										if (typeof(resultOrPromise) != 'object')
										{	return -resultOrPromise - 1;
										}
										return resultOrPromise.then(result => -result - 1);
									}
								)
							);
						}
						else
						{	return curPiper.pipeTo
							(	writer.closed,
								callbacksForRead,
								async chunk =>
								{	await writer.write(chunk);
									return -chunk.byteLength - 1;
								}
							);
						}
					}
				);
				if (isEof !== false)
				{	callbackAccessor.curPiper = undefined;
					if (options?.preventClose)
					{	await callbackAccessor.close();
					}
					else
					{	await Promise.all([callbackAccessor.close(), writer.close()]);
					}
				}
			}
			catch (e)
			{	if (callbackAccessor.error !== undefined)
				{	// Read error
					if (!options?.preventAbort)
					{	writer.abort(e);
					}
				}
				else
				{	// Write error
					if (!options?.preventCancel)
					{	this.cancel(e);
					}
				}
			}
			finally
			{	writer.releaseLock();
			}
		}
		finally
		{	this.releaseLock();
		}
	}

	/**	Uses `reader.pipeTo()` to pipe the data to transformer's writable stream, and returns transformer's readable stream.

		The transformer can be an instance of built-in `TransformStream<Uint8Array, unknown>`, `TrStream`, or any other `writable/readable` pair.

		Finally the reader will be unlocked.
	 **/
	pipeThrough<T, W extends WritableStream<Uint8Array>, R extends ReadableStream<T>>
	(	transform:
		{	readonly writable: W;
			readonly readable: R;
		},
		options?: PipeOptions
	)
	{	this.pipeTo(transform.writable, options).then(undefined, () => {});
		return transform.readable;
	}

	/**	Reads the whole stream to memory.
	 **/
	async uint8Array()
	{	try
		{	const callbackAccessor = this.getCallbackAccessor();
			const result = await callbackAccessor.useCallbacks
			(	async callbacks =>
				{	const chunks = new Array<Uint8Array>;
					const {curPiper} = callbackAccessor;
					if (curPiper)
					{	const chunk = curPiper.uint8Array();
						if (chunk)
						{	chunks[0] = chunk;
						}
						callbackAccessor.curPiper = undefined;
					}
					let totalLen = 0;
					let chunkSize = callbackAccessor.autoAllocateChunkSize || DEFAULT_AUTO_ALLOCATE_SIZE;
					const autoAllocateMin = callbackAccessor.autoAllocateMin;
					while (true)
					{	let chunk = new Uint8Array(chunkSize);
						while (chunk.byteLength >= autoAllocateMin)
						{	const nRead = await callbacks.read!(chunk);
							if (!nRead)
							{	await callbackAccessor.close();
								const {byteOffset} = chunk;
								if (byteOffset > 0)
								{	chunk = new Uint8Array(chunk.buffer, 0, byteOffset);
									totalLen += byteOffset;
									if (chunks.length == 0)
									{	return chunk;
									}
									chunks.push(chunk);
								}
								if (chunks.length == 0)
								{	return new Uint8Array;
								}
								if (chunks.length == 1)
								{	return chunks[0];
								}
								const result = new Uint8Array(totalLen);
								let pos = 0;
								for (const chunk of chunks)
								{	result.set(chunk, pos);
									pos += chunk.byteLength;
								}
								return result;
							}
							chunk = chunk.subarray(nRead);
						}
						const {byteOffset} = chunk;
						chunk = new Uint8Array(chunk.buffer, 0, byteOffset);
						totalLen += byteOffset;
						chunks.push(chunk);
						chunkSize *= 2;
					}
				}
			);
			return result ?? new Uint8Array;
		}
		finally
		{	this.releaseLock();
		}
	}

	/**	Reads the whole stream to memory, and converts it to string, just as `TextDecoder.decode()` does.
	 **/
	async text(label?: string, options?: TextDecoderOptions)
	{	return new TextDecoder(label, options).decode(await this.uint8Array());
	}
}

class ReadableStreamIterator implements AsyncIterableIterator<Uint8Array>
{	constructor(private reader: ReadableStreamDefaultReader<Uint8Array>, private preventCancel: boolean)
	{
	}

	[Symbol.asyncIterator]()
	{	return this;
	}

	async next(): Promise<IteratorResult<Uint8Array>>
	{	const {value, done} = await this.reader.read();
		if (value?.byteLength || !done)
		{	return {value, done: false};
		}
		return await this.return();
	}

	// deno-lint-ignore require-await
	async return(value?: Uint8Array): Promise<IteratorResult<Uint8Array>>
	{	this[Symbol.dispose]();
		return {value, done: true};
	}

	throw(): Promise<IteratorResult<Uint8Array>>
	{	return this.return();
	}

	[Symbol.dispose]()
	{	try
		{	if (!this.preventCancel)
			{	this.reader.cancel();
			}
		}
		finally
		{	this.reader.releaseLock();
		}
	}
}

class TeeRegular
{	#promise = Promise.resolve();
	#buffered = new Uint8Array;
	#bufferedFor: -1|0|1 = 0;
	#isEof = false;
	#cancelledNReader: -1|0|1 = 0;

	constructor(private reader: ReadableStreamBYOBReader)
	{
	}

	async read(view: Uint8Array, nReader: -1|1)
	{	if (this.#bufferedFor == nReader)
		{	// Have something buffered for me
			await this.#promise;
			const wantLen = this.#buffered.byteLength;
			if (wantLen==0 && this.#isEof)
			{	// Eof
				return null;
			}
			// Data
			const hasLen = view.byteLength;
			const len = Math.min(wantLen, hasLen);
			view.set(this.#buffered.subarray(0, len));
			if (len < wantLen)
			{	this.#buffered = this.#buffered.subarray(len);
			}
			else
			{	this.#buffered = new Uint8Array(this.#buffered.buffer, 0, 0);
			}
			this.#bufferedFor = 0;
			return len;
		}
		else
		{	// Read from the underlying reader
			this.#bufferedFor = -nReader as -1|1;
			let resolve: VoidFunction|undefined;
			if (this.#bufferedFor != this.#cancelledNReader)
			{	this.#promise = new Promise<void>(y => {resolve = y});
			}
			const {value, done} = await this.reader.read(view);
			resolve?.();
			if (done)
			{	this.#isEof = true;
				return null;
			}
			if (this.#bufferedFor != this.#cancelledNReader)
			{	// Buffer for the second reader
				const curLen = this.#buffered.byteLength;
				const newLen = curLen + value.byteLength;
				const totalLen = this.#buffered.buffer.byteLength;
				const {byteOffset} = this.#buffered;
				let newBuffered;
				if (totalLen < newLen)
				{	// The current buffer is too small (so allocate new and copy data from old)
					newBuffered = new Uint8Array(curLen==0 ? value.buffer.byteLength : bufferSizeFor(newLen)).subarray(0, newLen);
					newBuffered.set(this.#buffered);
				}
				else if (totalLen-byteOffset < newLen)
				{	// Space in the current buffer after the current content is too small (so enlarge view region and copyWithin)
					newBuffered = new Uint8Array(this.#buffered.buffer, 0, newLen);
					if (byteOffset > 0)
					{	new Uint8Array(this.#buffered.buffer, 0, totalLen).copyWithin(0, byteOffset, byteOffset+curLen);
					}
				}
				else
				{	// There's space after the current content (so enlarge view region)
					newBuffered = new Uint8Array(this.#buffered.buffer, byteOffset, newLen);
				}
				newBuffered.set(value, curLen);
				this.#buffered = newBuffered;
			}
			return value.byteLength;
		}
	}

	cancel(reason: Any, nReader: -1|1)
	{	if (this.#cancelledNReader == 0)
		{	this.#cancelledNReader = nReader;
			if (this.#bufferedFor == nReader)
			{	this.#buffered = new Uint8Array;
			}
		}
		else
		{	this.reader.cancel(reason);
		}
	}
}

class TeeRequireParallelRead
{	#doingNReader: -1|0|1 = 0;
	#promise = Promise.resolve({} as ReadableStreamBYOBReadResult<Uint8Array>);
	#resolve: VoidFunction|undefined;
	#secondReaderOffset = 0;
	#cancelledNReader: -1|0|1 = 0;

	constructor(private reader: ReadableStreamBYOBReader)
	{
	}

	async read(view: Uint8Array, nReader: -1|1)
	{	if (nReader == this.#cancelledNReader)
		{	return null;
		}
		// Assume: nReader is not cancelled (on next await this can cahnge)
		this.#doingNReader = nReader;
		if (!this.#resolve)
		{	// First reader
			this.#secondReaderOffset = 0;
			this.#promise = this.reader.read(view);
			const promise2 = this.#cancelledNReader==-nReader ? undefined : new Promise<void>(y => {this.#resolve = y});
			const {value, done} = await this.#promise;
			// Wait for the second reader
			if (promise2)
			{	await promise2;
			}
			// Return
			return done ? null : value.byteLength;
		}
		else
		{	// Second reader
			const {value, done} = await this.#promise; // get the result of the first reader
			if (done)
			{	this.#resolve();
				this.#resolve = undefined;
				return null;
			}
			const wantLen = value.byteLength - this.#secondReaderOffset;
			const hasLen = view.byteLength;
			const len = Math.min(wantLen, hasLen);
			view.set(value.subarray(this.#secondReaderOffset, this.#secondReaderOffset+len));
			if (len < wantLen)
			{	// Target buffer is too small, so i return without releasing the first read (`resolve()`), and wait for another read from the second reader.
				this.#secondReaderOffset += len;
				return len;
			}
			this.#resolve();
			this.#resolve = undefined;
			return len;
		}
	}

	cancel(reason: Any, nReader: -1|1)
	{	if (this.#cancelledNReader == 0)
		{	this.#cancelledNReader = nReader;
			if (this.#resolve && this.#doingNReader!=nReader)
			{	this.#resolve();
				this.#resolve = undefined;
			}
		}
		else
		{	this.reader.cancel(reason);
		}
	}
}

function bufferSizeFor(dataSize: number)
{	let bufferSize = 1024;
	while (bufferSize < dataSize)
	{	bufferSize *= 2;
	}
	return bufferSize;
}

class Piper
{	private buffer: Uint8Array;
	private readTo = 0; // position in buffer from where it's good to read more bytes, because there's `autoAllocateMin` space
	private readPos = 0; // read to `buffer[readPos ..]`
	private writePos = 0; // write from `buffer[writePos .. readPos]`
	private readPos2 = 0; // when `readPos > readTo` read to `buffer[readPos2 .. writePos]` over already read and written part of the buffer on the left of `writePos`
	private usingReadPos2 = false; // where do i read to? to `readPos` or `readPos2`
	private lastWriteCanReturnZero = true; // last write call was with `canReturnZero` flag
	private readPromise: number | null | PromiseLike<number|null> | undefined; // pending read operation that reads to the buffer
	private isEof = false; // i'll not read (i.e. create `readPromise`) if EOF reached

	constructor(autoAllocateChunkSize: number, autoAllocateMin: number)
	{	this.buffer = new Uint8Array(autoAllocateChunkSize);
		this.readTo = autoAllocateChunkSize - autoAllocateMin;
	}

	async pipeTo
	(	writerClosedPromise: Promise<void>,
		callbacksForRead: Callbacks,
		callbackWriteInverting: (chunk: Uint8Array, canReturnZero: boolean) => number | PromiseLike<number>,
	)
	{	let {buffer, readTo, readPos, writePos, readPos2, usingReadPos2, lastWriteCanReturnZero, readPromise, isEof} = this;
		let bufferSize = buffer.byteLength;
		let halfBufferSize = bufferSize<2 ? bufferSize : bufferSize >> 1;
		let writePromise: number | PromiseLike<number> | undefined; // pending write operation that writes from the buffer
		let writerClosed = false;
		writerClosedPromise.then(() => {writerClosed = true});
		// Assume: 0 <= readPos2 <= writePos <= readPos <= bufferSize
		// Can read to `buffer[readPos .. bufferSize]`, and then to `buffer[readPos2 .. writePos]`
		// Can write from `buffer[writePos .. readPos]`, and then `buffer[0 .. readPos2]` will become `buffer[writePos .. readPos]` (will set readPos to readPos2, writePos to 0, and readPos2 to 0)
		try
		{	while (true)
			{	// writerClosed?
				if (writerClosed)
				{	if (writePromise)
					{	writePos = readPos;
					}
					return false;
				}
				// Start (or continue) reading and/or writing
				if (readPromise===undefined && !isEof)
				{	if (readPos<=readTo || readPos2==0 && writePos>=1 && bufferSize-readPos>=writePos)
					{	// Read if there's at least `autoAllocateMin` bytes free after the `readPos`, or if `readPos2 == 0` and space at `buffer[.. writePos]` is not larger than the space at `buffer[readPos ..]`
						// `bufferSize-readPos` is number of free bytes after `readPos` (`buffer[readPos ..]`)
						// `writePos` is number of free bytes on the left (`buffer[.. writePos]`)
						// `writePos>=1 && bufferSize-readPos>=writePos` means that `bufferSize-readPos>=1` (i.e. there's space after `readPos`)
						usingReadPos2 = false;
						readPromise = callbacksForRead.read!
						(	readPos == 0 ?
								buffer.subarray(0, halfBufferSize) : // Don't try to read the full buffer, only it's half. The buffer is big enough (twice common size). This increases the chance that reading and writing will happen in parallel
								buffer.subarray(readPos)
						);
					}
					else if (readPos2 < writePos)
					{	// Read if there's free space on the left side of the already written position
						usingReadPos2 = true;
						readPromise = callbacksForRead.read!(buffer.subarray(readPos2, writePos));
					}
				}
				if (writePromise===undefined && readPos>writePos)
				{	// Write if there's something already read in the buffer
					lastWriteCanReturnZero = !isEof || readPos2!=0;
					writePromise = callbackWriteInverting(buffer.subarray(writePos, readPos), lastWriteCanReturnZero);
				}
				// Await for the fastest promise
				let size =
				(	typeof(readPromise)=='number' || readPromise===null ? // If result is ready (not promise)
						readPromise :
					typeof(writePromise)=='number' ? // If result is ready (not promise)
						writePromise :
						await (!readPromise ? writePromise : !writePromise ? readPromise : Promise.race([readPromise, writePromise]))
				);
				// Now we have either read or written something
				if (!size)
				{	// Read EOF
					readPromise = undefined;
					isEof = true;
					if (!writePromise)
					{	if (!usingReadPos2 || readPos2==0)
						{	return true;
						}
						readPos = readPos2;
						readPos2 = 0;
						writePos = 0;
					}
				}
				else if (size > 0)
				{	// Read a chunk
					readPromise = undefined;
					if (!usingReadPos2)
					{	// Read from `readPos` to `readPos + size`
						readPos += size;
					}
					else
					{	// Read from `readPos2` to `readPos2 + size`
						readPos2 += size;
						if (readPos == writePos)
						{	readPos = readPos2;
							readPos2 = 0;
							writePos = 0;
						}
					}
				}
				else
				{	// Written
					size = -size - 1;
					writePromise = undefined;
					if (size > 0)
					{	writePos += size;
						if (readPos==writePos && !readPromise)
						{	readPos = readPos2;
							readPos2 = 0;
							writePos = 0;
							if (isEof && readPos==0)
							{	return true;
							}
						}
					}
					else
					{	// They want a larger chunk
						if (readPromise)
						{	// writerClosed?
							if (writerClosed)
							{	writePos = readPos;
								return false;
							}
							// Read
							size = await readPromise;
							readPromise = undefined;
							if (!size)
							{	// Read EOF
								isEof = true;
							}
							else if (!usingReadPos2)
							{	// Read from `readPos` to `readPos + size`
								readPos += size;
								continue;
							}
							else
							{	// Read from `readPos2` to `readPos2 + size`
								readPos2 += size;
							}
						}
						const holeSize = bufferSize - readPos;
						if (holeSize > 0) // If there's hole on the right (because i prefer to read to the left when there's more space)
						{	if (readPos2 > 0)  // If there's something read on the left
							{	// Move the data from left to right
								const copySize = Math.min(holeSize, readPos2);
								buffer.copyWithin(readPos, 0, copySize);
								buffer.copyWithin(0, copySize, readPos2);
								readPos += copySize;
								readPos2 -= copySize;
							}
							else if (isEof)
							{	if (!lastWriteCanReturnZero)
								{	throw new Error(`write() returned 0 during pipeTo() when there're no more data`);
								}
								// Call write callback again with `!canReturnZero`
							}
							else
							{	size = await callbacksForRead.read!(buffer.subarray(readPos)); // Read to the hole
								if (!size)
								{	// Read EOF
									isEof = true;
								}
								else
								{	// Read from `readPos` to `readPos + size`
									readPos += size;
								}
							}
						}
						else if (writePos > 0)
						{	if (readPos2 > 0)  // If there's something read on the left
							{	const leftPart = buffer.slice(0, readPos2);
								readPos2 = 0;
								buffer.copyWithin(0, writePos, readPos);
								readPos -= writePos;
								writePos = 0;
								buffer.set(leftPart, readPos);
								readPos += leftPart.byteLength;
							}
							else if (isEof)
							{	if (!lastWriteCanReturnZero)
								{	throw new Error(`write() returned 0 during pipeTo() when there're no more data`);
								}
								// Call write callback again with `!canReturnZero`
							}
							else
							{	buffer.copyWithin(0, writePos, readPos);
								readPos -= writePos;
								writePos = 0;
								usingReadPos2 = false;
								size = await callbacksForRead.read!(buffer.subarray(readPos)); // Read
								if (!size)
								{	// Read EOF
									isEof = true;
								}
								else
								{	// Read from `readPos` to `readPos + size`
									readPos += size;
								}
							}
						}
						else
						{	// Assume: `readPos == bufferSize` (because `holeSize==0` above)
							// Assume: `writePos == 0` (see above)
							// Assume: `readPos2 == 0` (because `0 <= readPos2 <= writePos`)
							if (!isEof)
							{	// The buffer is full, but not EOF, so enlarge the buffer
								halfBufferSize = bufferSize;
								bufferSize *= 2;
								const tmp = new Uint8Array(bufferSize);
								tmp.set(buffer);
								buffer = tmp;
							}
							else
							{	if (!lastWriteCanReturnZero)
								{	throw new Error(`write() returned 0 for ${bufferSize} bytes chunk during pipeTo()`);
								}
								lastWriteCanReturnZero = false;
								writePromise = callbackWriteInverting(buffer.subarray(writePos, readPos), lastWriteCanReturnZero);
							}
						}
					}
				}
			}
		}
		catch (e)
		{	// Await writePromise
			if (writePromise)
			{	try
				{	await writePromise;
				}
				catch
				{	// ok
				}
			}
			// Rethrow
			throw e;
		}
		finally
		{	this.buffer = buffer;
			this.readPos = readPos;
			this.writePos = writePos;
			this.readPos2 = readPos2;
			this.usingReadPos2 = usingReadPos2;
			this.lastWriteCanReturnZero = lastWriteCanReturnZero;
			this.readPromise = readPromise;
			this.isEof = isEof;
		}
	}

	read(view: Uint8Array)
	{	const {buffer, readPos, writePos, readPos2} = this;
		if (writePos < readPos)
		{	const n = Math.min(view.byteLength, readPos-writePos);
			const nextWritePos = writePos + n;
			view.set(buffer.subarray(writePos, nextWritePos));
			if (nextWritePos == readPos)
			{	this.readPos = readPos2;
				this.readPos2 = 0;
				this.writePos = 0;
			}
			else
			{	this.writePos = nextWritePos;
			}
			return n;
		}
		return 0;
	}

	uint8Array()
	{	const {buffer, readPos, writePos} = this;
		if (writePos < readPos)
		{	return buffer.subarray(writePos, readPos);
		}
	}
}
