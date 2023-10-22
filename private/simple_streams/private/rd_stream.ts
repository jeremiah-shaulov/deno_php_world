import {DEFAULT_AUTO_ALLOCATE_SIZE, Callbacks, CallbackAccessor, ReaderOrWriter} from './common.ts';
import {Writer} from './wr_stream.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

export type Source =
{	// Properties:

	/**	If undefined or non-positive number, will use predefined default value (like 32 KiB) when allocating buffers.
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
	 **/
	read(view: Uint8Array): number | null | PromiseLike<number|null>;

	/**	This method is called when {@link Source.read} returns `0` or `null` that indicate EOF.
		If you use `Deno.Reader & Deno.Closer` as source, that source will be closed when read to the end without error.
	 **/
	close?(): void | PromiseLike<void>;

	/**	Is called as response to `rdStream.cancel()` or `reader.cancel()`.
	 **/
	cancel?(reason: Any): void | PromiseLike<void>;

	/**	Is called when `read()` or `start()` thrown exception or returned a rejected promise.
	 **/
	catch?(reason: Any): void | PromiseLike<void>;
};

type Transform<W extends WritableStream<Uint8Array>, R extends ReadableStream<unknown>> =
{	readonly writable: W;
	readonly readable: R;

	/**	If this value is set to a positive integer, `RdStream.pipeThrough()` will use buffer of this size during piping.
		Practically this affects maximum chunk size in `transform(writer, chunk)` callback.
		If that callback returns `0` indicating that it wants more bytes, it will be called again with a larger chunk, till the chunk size reaches `overrideAutoAllocateChunkSize`.
		Then, if it still returns `0`, an error is thrown.
	 **/
	readonly overrideAutoAllocateChunkSize?: number;
};

/**	This class extends `ReadableStream<Uint8Array>`, and can be used as it's substitutor.
	However it removes as much of `ReadableStream` complexity as possible.

	- It doesn't use controllers.
	You define reader source as `Deno.Reader`-compatible object, and writer sink as `Deno.Writer`-compatible.
	(Even when `Deno.Reader` and `Deno.Writer` will be removed from Deno, this library will continue supporting the same simple interfaces).
	- Data consumer can use BYOB or regular reading mode, and you don't need to handle these situations differently.
	- It doesn't transfer buffers that you pass to `reader.read(buffer)`, so they remain usable after the call.
	- It guarantees not to buffer data for future `read()` calls.
 **/
export class RdStream extends ReadableStream<Uint8Array>
{	// static:

	/**	Converts iterable of `Uint8Array` to `RdStream`.
		`ReadableStream<Uint8Array>` is also iterable of `Uint8Array`, so it can be converted,
		and the resulting `RdStream` will be wrapper on the provided readable stream.
		This can be useful to use `RdStream` functionality that doesn't exist on `ReadableStream`.
		Also `RdStream.pipeTo()` implementation is more efficient than in `ReadableStream` (at least in Deno `1.37.2`),
		so can work faster and/or consume less memory, despite the fact that the data will be eventually read from the same uderlying stream object.

		If you have data source that implements both `ReadableStream<Uint8Array>` and `Deno.Reader`, it will be more efficient to create wrapper from `Deno.Reader`
		by calling `RdStream` constructor.

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

	#autoAllocateChunkSize: number;
	#autoAllocateMin: number;
	#callbackAccessor: ReadCallbackAccessor;
	#locked = false;
	#readerRequests = new Array<(reader: ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader) => void>;
	#curPiper: Piper|undefined;

	/**	When somebody wants to start reading this stream, he calls `rdStream.getReader()`, and after this call the stream becomes locked.
		Further calls to `rdStream.getReader()` will throw error till the reader is released (`reader.releaseLock()`).

		Other operations that read the stream (like `rdStream.pipeTo()`) also lock it (internally they get a reader, and later release it).
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
		this.#autoAllocateChunkSize = autoAllocateChunkSize;
		this.#autoAllocateMin = autoAllocateMin;
		this.#callbackAccessor = new ReadCallbackAccessor(autoAllocateChunkSize, autoAllocateMin, source);
	}

	// methods:

	/**	Returns object that allows to read data from the stream.
		The stream becomes locked till this reader is released by calling `reader.releaseLock()`.

		If the stream is already locked, this method throws error.
	 **/
	getReader(options?: {mode?: undefined}): ReadableStreamDefaultReader<Uint8Array>;
	getReader(options: {mode: 'byob'}): ReadableStreamBYOBReader;
	getReader(_options?: {mode?: 'byob'}): ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader
	{	if (this.#locked)
		{	throw new TypeError('ReadableStream is locked.');
		}
		this.#locked = true;
		return new Reader
		(	this.#callbackAccessor,
			() =>
			{	this.#locked = false;
				const y = this.#readerRequests.pop();
				if (y)
				{	y(this.getReader());
				}
			}
		);
	}

	/**	Like `rdStream.getReader()`, but waits for the stream to become unlocked before returning the reader (and so locking it again).

		If you actually don't need the reader, but just want to catch the moment when the stream unlocks, you can do:

		```ts
		(await rdStream.getReaderWhenReady()).releaseLock();
		// here you can immediately (without awaiting any promises) call `pipeTo()`, or something else
		```
	 **/
	getReaderWhenReady(options?: {mode?: undefined}): Promise<ReadableStreamDefaultReader<Uint8Array>>;
	getReaderWhenReady(options: {mode: 'byob'}): Promise<ReadableStreamBYOBReader>;
	getReaderWhenReady(_options?: {mode?: 'byob'}): Promise<ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader>
	{	if (!this.#locked)
		{	return Promise.resolve(this.getReader());
		}
		return new Promise<ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader>(y => {this.#readerRequests.push(y)});
	}

	/**	Tells to discard further data in the stream.
		This leads to calling `source.cancel(reason)` that must implement the actual behavior.

		In contrast to `ReadableStream.cancel()`, this method works even if the stream is locked, cancelling current read operation.
	 **/
	cancel(reason?: Any)
	{	return this.#callbackAccessor.close(true, reason);
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
	{	const reader = this.getReader({mode: 'byob'});
		const tee = options?.requireParallelRead ? new TeeRequireParallelRead(reader) : new TeeRegular(reader);

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
	 **/
	pipeTo(dest: WritableStream<Uint8Array>, options?: PipeOptions)
	{	return this.#pipeTo(dest, options);
	}

	/**	Uses `rdStream.pipeTo()` to pipe the data to transformer's writable stream, and returns transformer's readable stream.

		The transformer can be an instance of built-in `TransformStream<Uint8Array, unknown>`, `TrStream`, or any other `writable/readable` pair.
	 **/
	pipeThrough<T, W extends WritableStream<Uint8Array>, R extends ReadableStream<T>>
	(	transform: Transform<W, R>,
		options?: PipeOptions
	)
	{	if (this.#locked)
		{	throw new TypeError('ReadableStream is locked.');
		}
		this.#pipeTo(transform.writable, options, transform.overrideAutoAllocateChunkSize).then(undefined, () => {});
		return transform.readable;
	}

	async #pipeTo(dest: WritableStream<Uint8Array>, options?: PipeOptions, overrideAutoAllocateChunkSize?: number)
	{	const reader = this.getReader({mode: 'byob'});
		try
		{	const writer = dest.getWriter();
			const autoAllocateChunkSize = overrideAutoAllocateChunkSize && overrideAutoAllocateChunkSize>0 ? overrideAutoAllocateChunkSize : this.#autoAllocateChunkSize;
			const autoAllocateMin = overrideAutoAllocateChunkSize && overrideAutoAllocateChunkSize>0 ? Math.min(overrideAutoAllocateChunkSize, Math.max(256, overrideAutoAllocateChunkSize >> 3)) : this.#autoAllocateMin;
			const curPiper = this.#curPiper ?? new Piper(autoAllocateChunkSize, autoAllocateMin);
			this.#curPiper = curPiper;
			try
			{	const signal = options?.signal;
				if (signal)
				{	if (signal.aborted)
					{	throw signal.reason;
					}
					signal.addEventListener('abort', () => {writer.abort(signal.reason)});
				}
				const isEof = await this.#callbackAccessor.useCallbacks
				(	callbacksForRead =>
					{	if ('useLowLevelCallbacks' in writer)
						{	return (writer as Writer).useLowLevelCallbacks
							(	callbacksForWrite => curPiper.pipeTo
								(	writer.closed,
									callbacksForRead,
									(chunk, canRedo) =>
									{	const resultOrPromise = callbacksForWrite.write!(chunk, canRedo);
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
				{	this.#curPiper = undefined;
					if (options?.preventClose)
					{	await this.#callbackAccessor.close();
					}
					else
					{	await Promise.all([this.#callbackAccessor.close(), writer.close()]);
					}
				}
			}
			catch (e)
			{	if (this.#callbackAccessor.error !== undefined)
				{	// Read error
					if (!options?.preventAbort)
					{	writer.abort(e);
					}
				}
				else
				{	// Write error
					if (!options?.preventCancel)
					{	reader.cancel(e);
					}
				}
			}
			finally
			{	writer.releaseLock();
			}
		}
		finally
		{	reader.releaseLock();
		}
	}

	/**	Ex-`Deno.Reader` implementation for this object.
		It gets a reader (locks the stream), reads, and then releases the reader (unlocks the stream).
		It returns number of bytes loaded to the `view`, or `null` on EOF.
	 **/
	async read(view: Uint8Array)
	{	if (view.byteLength == 0)
		{	return 0;
		}
		const reader = this.getReader({mode: 'byob'});
		try
		{	const view2 = await this.#callbackAccessor.read(view);
			return !view2 ? null : view2.byteLength;
		}
		finally
		{	reader.releaseLock();
		}
	}

	/**	Reads the whole stream to memory.
	 **/
	async uint8Array()
	{	const reader = this.getReader({mode: 'byob'});
		try
		{	const result = await this.#callbackAccessor.useCallbacks
			(	async callbacks =>
				{	const chunks = new Array<Uint8Array>;
					let totalLen = 0;
					let chunkSize = this.#autoAllocateChunkSize || DEFAULT_AUTO_ALLOCATE_SIZE;
					const autoAllocateMin = this.#autoAllocateMin;
					while (true)
					{	let chunk = new Uint8Array(chunkSize);
						while (chunk.byteLength >= autoAllocateMin)
						{	const nRead = await callbacks.read!(chunk);
							if (!nRead)
							{	await this.#callbackAccessor.close();
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
		{	reader.releaseLock();
		}
	}

	/**	Reads the whole stream to memory, and converts it to string, just as `TextDecoder.decode()` does.
	 **/
	async text(label?: string, options?: TextDecoderOptions)
	{	return new TextDecoder(label, options).decode(await this.uint8Array());
	}
}

class ReadCallbackAccessor extends CallbackAccessor
{	#autoAllocateBuffer: Uint8Array|undefined;

	constructor
	(	private autoAllocateChunkSize: number,
		private autoAllocateMin: number,
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
{	async read<V extends ArrayBufferView>(view?: V): Promise<ReadableStreamBYOBReadResult<V>>
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
}

class ReadableStreamIterator implements AsyncIterableIterator<Uint8Array>
{	#reader: ReadableStreamDefaultReader<Uint8Array>;

	constructor(stream: RdStream, private preventCancel: boolean)
	{	this.#reader = stream.getReader();
	}

	[Symbol.asyncIterator]()
	{	return this;
	}

	async next(): Promise<IteratorResult<Uint8Array>>
	{	const {value, done} = await this.#reader.read();
		if (value?.byteLength || !done)
		{	return {value, done: false};
		}
		return await this.return();
	}

	// deno-lint-ignore require-await
	async return(value?: Uint8Array): Promise<IteratorResult<Uint8Array>>
	{	if (!this.preventCancel)
		{	this.#reader.cancel();
		}
		this.#reader.releaseLock();
		return {value, done: true};
	}

	throw(): Promise<IteratorResult<Uint8Array>>
	{	return this.return();
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
	private readPos = 0; // read to `buffer[readPos ..]`
	private writePos = 0; // write from `buffer[writePos .. readPos]`
	private readPos2 = 0; // when `readPos > readTo` read to `buffer[readPos2 .. writePos]` over already read and written part of the buffer on the left of `writePos`
	private usingReadPos2 = false; // where do i read to? to `readPos` or `readPos2`
	private readPromise: number | null | PromiseLike<number|null> | undefined; // pending read operation that reads to the buffer
	private isEof = false; // i'll not read (i.e. create `readPromise`) if EOF reached

	constructor(private autoAllocateChunkSize: number, private autoAllocateMin: number)
	{	this.buffer = new Uint8Array(autoAllocateChunkSize);
	}

	async pipeTo
	(	writerClosedPromise: Promise<void>,
		callbacksForRead: Callbacks,
		callbackWriteInverting: (chunk: Uint8Array, canRedo: boolean) => number | PromiseLike<number>,
	)
	{	let {autoAllocateChunkSize, autoAllocateMin, buffer, readPos, writePos, readPos2, usingReadPos2, readPromise, isEof} = this;
		const readTo = autoAllocateChunkSize - autoAllocateMin;
		const halfBufferSize = autoAllocateChunkSize<2 ? autoAllocateChunkSize : autoAllocateChunkSize >> 1;
		let writePromise: number | PromiseLike<number> | undefined; // pending write operation that writes from the buffer
		let writerClosed = false;
		writerClosedPromise.then(() => {writerClosed = true});
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
				{	if (readPos<=readTo || readPos2==0 && writePos>=1 && autoAllocateChunkSize-readPos>=writePos)
					{	// Read if there's at least `autoAllocateMin` bytes free after the `readPos`, or if `readPos2 == 0` and space at `buffer[.. writePos]` is not larger than the space at `buffer[readPos ..]`
						// `autoAllocateChunkSize-readPos` is number of free bytes after `readPos` (`buffer[readPos ..]`)
						// `writePos` is number of free bytes on the left (`buffer[.. writePos]`)
						// `writePos>=1 && autoAllocateChunkSize-readPos>=writePos` means that `autoAllocateChunkSize-readPos>=1` (i.e. there's space after `readPos`)
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
					writePromise = callbackWriteInverting(buffer.subarray(writePos, readPos), !(readPos==autoAllocateChunkSize && writePos==0 || isEof && readPos2==0));
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
						const justReadMoreDataOrEof = !!readPromise;
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
						const holeSize = autoAllocateChunkSize - readPos;
						if (holeSize > 0) // If there's hole on the right (because i prefer to read to the left when there's more space)
						{	if (readPos2 > 0)  // If there's something read on the left
							{	// Move the data from left to right
								const copySize = Math.min(holeSize, readPos2);
								buffer.copyWithin(readPos, 0, copySize);
								buffer.copyWithin(0, copySize, readPos2);
								readPos += copySize;
								readPos2 -= copySize;
							}
							else if (!isEof)
							{	readPromise = callbacksForRead.read!(buffer.subarray(readPos)); // Read to the hole
							}
							else if (!justReadMoreDataOrEof)
							{	throw new Error(`write() returned 0 during pipeTo() when there're no more data`);
							}
						}
						else if (writePos > 0)
						{	let leftPart;
							if (readPos2 > 0)  // If there's something read on the left
							{	leftPart = new Uint8Array(readPos2);
								leftPart.set(buffer.subarray(0, readPos2));
								readPos2 = 0;
							}
							else if (isEof)
							{	if (justReadMoreDataOrEof)
								{	continue; // Call write callback again with `!canRedo`
								}
								throw new Error(`write() returned 0 during pipeTo() when there're no more data`);
							}
							buffer.copyWithin(0, writePos, readPos);
							readPos -= writePos;
							writePos = 0;
							if (leftPart)
							{	buffer.set(leftPart, readPos);
								readPos += leftPart.byteLength;
							}
							else
							{	readPromise = callbacksForRead.read!(buffer.subarray(readPos)); // Read
							}
						}
						else if (!justReadMoreDataOrEof || isEof)
						{	throw new Error(`write() returned 0 for ${autoAllocateChunkSize} bytes chunk during pipeTo()`);
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
		{	this.readPos = readPos;
			this.writePos = writePos;
			this.readPos2 = readPos2;
			this.usingReadPos2 = usingReadPos2;
			this.readPromise = readPromise;
			this.isEof = isEof;
		}
	}
}