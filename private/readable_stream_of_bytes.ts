const DEFAULT_AUTO_ALLOCATE_SIZE = 32*1024;

// deno-lint-ignore no-explicit-any
type Any = any;

type StartOrPull = (controller: Controller) => void | PromiseLike<void>;

interface Source
{	/**	The type of controller is always `bytes`, and you can specify this explicitly
		to make the object compatible with `new ReadableStream(obj)`.
	 **/
	type?: 'bytes',

	/**	If undefined or negative number, will use predefined default value (like 8KiB) when allocating buffers.
		The buffer in byob request object (`byobRequest.view`) is always allocated (non-byob mode) or passed from caller (byob mode).
		If 0, `byobRequest.view` in non-byob will have 0 size.
		This is reasonable if you're planning to enqueue `Uint8Array` objects from your own source.
	 **/
	autoAllocateChunkSize?: number;

	/**	When auto-allocating (reading in non-byob mode) don't call `pull()` with buffers smaller than this.
		First i'll allocate `autoAllocateChunkSize` bytes, and if `pull()` callback responds with a small subarray (so there're >= `autoAllocateMin` unused bytes in the buffer), i'll reuse that part of the buffer in next pull calls.
	 **/
	autoAllocateMin?: number;

	start?: StartOrPull;
	pull?: StartOrPull;
	cancel?: (reason: Any) => void | PromiseLike<void>;
}

/**	This class extends `ReadableStream<Uint8Array>`, and can be used as it's substitutor.
	It has similar API and behavior.
	The main difference is that it doesn't transfer buffers.
	Buffers that you give to `reader.read(buffer)` remain usable after the call.
 **/
export class ReadableStreamOfBytes extends ReadableStream<Uint8Array>
{	#autoAllocateChunkSize: number;
	#autoAllocateMin: number;
	#puller: Puller;

	static from<R>(source: AsyncIterable<R> | Iterable<R | PromiseLike<R>>): ReadableStream<R> & ReadableStreamOfBytes
	{	if (source instanceof ReadableStreamOfBytes)
		{	return source as Any;
		}
		else if (source instanceof ReadableStream)
		{	let reader: ReadableStreamBYOBReader|undefined;
			return new ReadableStreamOfBytes
			(	{	async pull(controller)
					{	if (!reader)
						{	reader = source.getReader({mode: 'byob'});
							reader.closed.then(() => reader?.releaseLock(), () => {});
						}
						const {value, done} = await reader.read(controller.byobRequest.view);
						if (value)
						{	controller.byobRequest.view = value;
							controller.byobRequest.respond(value.byteLength);
						}
						if (done)
						{	controller.close();
						}
					},
					cancel(reason)
					{	(reader ?? source).cancel(reason);
					}
				}
			) as Any;
		}
		else if (Symbol.asyncIterator in source)
		{	const it = source[Symbol.asyncIterator]();
			return new ReadableStreamOfBytes
			(	{	autoAllocateChunkSize: 0,
					async pull(controller)
					{	const {value, done} = await it.next();
						if (done)
						{	controller.close();
						}
						else if (value instanceof Uint8Array)
						{	controller.enqueue(value);
						}
						else
						{	controller.error('Must be async iterator of Uint8Array');
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
			return new ReadableStreamOfBytes
			(	{	autoAllocateChunkSize: 0,
					async pull(controller)
					{	const {value, done} = it.next();
						if (done)
						{	controller.close();
						}
						else
						{	const item = await value;
							if (item instanceof Uint8Array)
							{	controller.enqueue(item);
							}
							else
							{	controller.error('Must be iterator of Uint8Array');
							}
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

	constructor(underlyingSource?: Source)
	{	const autoAllocateChunkSizeU = underlyingSource?.autoAllocateChunkSize;
		const autoAllocateChunkSize = autoAllocateChunkSizeU==undefined || autoAllocateChunkSizeU<0 ? DEFAULT_AUTO_ALLOCATE_SIZE : autoAllocateChunkSizeU;
		const autoAllocateMinU = underlyingSource?.autoAllocateMin;
		const autoAllocateMin = autoAllocateMinU==undefined || autoAllocateMinU<0 ? autoAllocateChunkSize >> 3 : autoAllocateMinU;
		const start = underlyingSource?.start;
		const cancel = underlyingSource?.cancel;
		const pull = underlyingSource?.pull;
		let puller!: Puller;
		super
		(	{	start(controller)
				{	puller = new Puller(autoAllocateChunkSize, autoAllocateMin, pull, controller);
					return puller.start(start);
				},
				cancel(reason)
				{	puller.cancelled();
					return cancel?.(reason);
				},
			}
		);
		this.#autoAllocateChunkSize = autoAllocateChunkSize;
		this.#autoAllocateMin = autoAllocateMin;
		this.#puller = puller;
	}

	getReader(options?: {mode?: undefined}): ReadableStreamDefaultReader<Uint8Array>;
	getReader(options: {mode: 'byob'}): ReadableStreamBYOBReader;
	getReader(_options?: {mode?: 'byob'}): ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader
	{	return new Reader(super.getReader(), this.#puller);
	}

	[Symbol.asyncIterator](options?: {preventCancel?: boolean})
	{	return new ReadableStreamIterator(this, options?.preventCancel===true);
	}

	values(options?: {preventCancel?: boolean})
	{	return new ReadableStreamIterator(this, options?.preventCancel===true);
	}

	/**	If one reader reads faster than another, or one of the readers doesn't read at all,
		the default behavior is to buffer the data.

		If `requireParallelRead` is set, will not buffer. Parent reader will suspend after each item,
		till it's read by both of the streams.
		In this case if you read and await from the first reader, and don't start reading from the second,
		this will cause a deadlock situation.
	 **/
	tee(options?: {requireParallelRead?: boolean}): [ReadableStreamOfBytes, ReadableStreamOfBytes]
	{	const reader = this.getReader({mode: 'byob'});
		const tee =  options?.requireParallelRead ? new TeeRequireParallelRead(reader) : new TeeRegular(reader);

		return [
			new ReadableStreamOfBytes
			(	{	pull: controller => tee.pull(controller, -1),
					cancel: reason => tee.cancel(reason, -1),
				}
			),
			new ReadableStreamOfBytes
			(	{	pull: controller => tee.pull(controller, +1),
					cancel: reason => tee.cancel(reason, +1),
				}
			),
		];
	}

	async uint8Array()
	{	const reader = this.getReader({mode: 'byob'});
		try
		{	const chunks = new Array<Uint8Array>;
			let totalLen = 0;
			let chunkSize = this.#autoAllocateChunkSize || DEFAULT_AUTO_ALLOCATE_SIZE;
			const autoAllocateMin = this.#autoAllocateMin;
			while (true)
			{	let chunk = new Uint8Array(chunkSize);
				while (chunk.byteLength >= autoAllocateMin)
				{	const {value, done} = await reader.read(chunk);
					if (done)
					{	if (chunks.length == 0)
						{	return new Uint8Array(0);
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
					chunk = chunk.subarray(value.byteLength);
				}
				const chunkLen = chunk.byteOffset;
				chunks.push(new Uint8Array(chunk.buffer, 0, chunkLen));
				totalLen += chunkLen;
				chunkSize *= 2;
			}
		}
		finally
		{	reader.releaseLock();
		}
	}
}

/**	This class plays the same role in `ReadableStreamOfBytes` as does `ReadableByteStreamController` in `ReadableStream<Uint8Array>`.
 **/
class Controller
{	readonly desiredSize: number;
	readonly byobRequest: ByobRequest;

	constructor(private puller: Puller, view: Uint8Array, private isUserSuppliedBuffer: boolean)
	{	this.desiredSize = view.byteLength;
		this.byobRequest = new ByobRequest(this, view, isUserSuppliedBuffer);
	}

	enqueue(chunk: Uint8Array)
	{	this.puller.enqueue(chunk, this.byobRequest.view, this.isUserSuppliedBuffer);
	}

	close()
	{	this.puller.close();
	}

	error(error?: Any)
	{	this.puller.error(error);
	}
}

/**	This class plays the same role in `ReadableStreamOfBytes` as does `ReadableStreamBYOBRequest` in `ReadableStream<Uint8Array>`.
 **/
class ByobRequest
{	constructor
	(	private controller: Controller,

		/**	If the caller uses `reader.read(view)` to read from his reader, this property contains the `view` from the call.
			It can be of any size.

			In case of `reader.read()`, this is a new allocated buffer, that can also be of any size, not only `autoAllocateChunkSize`.
			Initially i'll allocate `autoAllocateChunkSize` bytes, but if you respond with only a small subarray of them,
			the rest of the buffer will be used in next byob requests.

			Reassigning this property will cause `reader.read(view)` to return not the same view object that is passed to the argument.
			You may want to reassign if you transfer the `view.buffer`.
			If the original view was allocated by me, and you reassign it, i'll use the assigned object as it was mine.
		 **/
		public view: Uint8Array,

		/**	True if the caller passes his own buffer to `reader.read` (`reader.read(view)`), and false if not (`reader.read()`).
		 **/
		readonly isUserSuppliedBuffer: boolean,
	)
	{
	}

	/**	Enqueue first `bytesWritten` bytes from `view`.
		This works the same as doing `controller.enqueue(new Uint8Array(controller.byobRequest.view.buffer, controller.byobRequest.view.byteOffset, bytesWritten))`.
		`controller.enqueue()` can also be used to respond to the byob request.
	 **/
	respond(bytesWritten: number)
	{	const {view} =  this;
		this.controller.enqueue(new Uint8Array(view.buffer, view.byteOffset, bytesWritten));
	}

	/**	Respond with a `ArrayBufferView` (usually `Uint8Array`) object.
		If that object uses the same buffer as `byobRequest.view` and has the same `byteOffset`, then the call will be equivalent to `respond(view.byteLength)`.
		Don't use parts of `byobRequest.view.buffer` that are outside the `byobRequest.view`.

		If you respond with a different object than this `byobRequest` contains, this object will be returned to whoever called `reader.read()` or `reader.read(view)`,
		and in this case if the `byobRequest.view` was allocated by me, i'll reuse this allocated object in next byob requests.
	 **/
	respondWithNewView(view: ArrayBufferView)
	{	this.controller.enqueue(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
	}
}

/**	This class plays the same role in `ReadableStreamOfBytes` as does `ReadableStreamBYOBReader` in `ReadableStream<Uint8Array>`.
 **/
class Reader
{	constructor
	(	private underlyingReader: ReadableStreamDefaultReader<Uint8Array>,
		private puller: Puller,
	)
	{
	}

	get closed()
	{	return this.underlyingReader.closed;
	}

	cancel(reason?: Any)
	{	return this.underlyingReader.cancel(reason);
	}

	releaseLock()
	{	this.underlyingReader.releaseLock();
	}

	async read<V extends ArrayBufferView>(view?: V): Promise<ReadableStreamBYOBReadResult<V>>
	{	if (view && !(view instanceof Uint8Array))
		{	throw new Error('Only Uint8Array is supported'); // i always return `Uint8Array`, and it must be `V`
		}
		this.puller.pull(view); // 1 pull - 1 read
		const {value, done} = await this.underlyingReader.read();
		return {value: done ? view?.subarray(0, 0) : value as Any, done};
	}
}

class Puller
{	#ongoing: PromiseLike<void> = Promise.resolve();
	#wantToPull = 0;
	#nQueued = 0;
	#recycledBuffer: Uint8Array|undefined;

	constructor
	(	private autoAllocateChunkSize: number,
		private autoAllocateMin: number,
		private underlyingPull: StartOrPull|undefined,
		private underlyingController: ReadableStreamDefaultController<Uint8Array>
	)
	{
	}

	start(underlyingStart: StartOrPull|undefined)
	{	if (underlyingStart)
		{	const startPromise = underlyingStart?.(new Controller(this, new Uint8Array, false));
			if (startPromise)
			{	this.#ongoing = startPromise;
				return startPromise;
			}
		}
	}

	pull(view?: Uint8Array)
	{	if (this.underlyingPull)
		{	this.#wantToPull++;
			this.#ongoing = this.#ongoing.then
			(	async () =>
				{	if (this.underlyingPull && this.#wantToPull>this.#nQueued)
					{	try
						{	let isUserSuppliedBuffer = true;
							if (!view)
							{	view = this.#recycledBuffer ?? new Uint8Array(this.autoAllocateChunkSize);
								this.#recycledBuffer = undefined;
								isUserSuppliedBuffer = false;
							}
							const prevNQueued = this.#nQueued;
							await this.underlyingPull(new Controller(this, view, isUserSuppliedBuffer));
							if (this.#nQueued == prevNQueued)
							{	this.underlyingPull = undefined; // don't call `pull` if it doesn't enqueue
							}
						}
						catch (e)
						{	this.error(e);
						}
					}
				}
			);
		}
	}

	enqueue(chunk: Uint8Array, view: Uint8Array, isUserSuppliedBuffer: boolean)
	{	if (!isUserSuppliedBuffer)
		{	if (chunk.buffer != view.buffer)
			{	this.#recycledBuffer = view;
			}
			else
			{	const end = chunk.byteOffset + chunk.byteLength;
				if (chunk.buffer.byteLength-end >= this.autoAllocateMin)
				{	this.#recycledBuffer = new Uint8Array(chunk.buffer, end);
				}
			}
		}
		this.#nQueued++;
		this.underlyingController.enqueue(chunk);
	}

	close()
	{	this.underlyingPull = undefined; // don't call `pull` anymore
		this.underlyingController.close();
	}

	error(error?: Any)
	{	this.underlyingPull = undefined; // don't call `pull` anymore
		this.underlyingController.error(error);
	}

	cancelled()
	{	this.underlyingPull = undefined; // don't call `pull` anymore
	}
}

class ReadableStreamIterator implements AsyncIterableIterator<Uint8Array>
{	#reader: ReadableStreamDefaultReader<Uint8Array>;

	constructor(stream: ReadableStreamOfBytes, private preventCancel: boolean)
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

	async pull(controller: Controller, nReader: -1|1)
	{	if (this.#bufferedFor == nReader)
		{	// Have something buffered for me
			await this.#promise;
			const wantLen = this.#buffered.byteLength;
			if (wantLen > 0)
			{	// Data
				if (this.#isEof && !controller.byobRequest.isUserSuppliedBuffer)
				{	// Last item before EOF, and the user doesn't read to his own buffer
					controller.enqueue(this.#buffered);
					this.#buffered = new Uint8Array;
				}
				else
				{	const {view} = controller.byobRequest;
					const hasLen = view.byteLength;
					const len = Math.min(wantLen, hasLen);
					view.set(this.#buffered.subarray(0, len));
					controller.byobRequest.respond(len);
					if (len < wantLen)
					{	this.#buffered = this.#buffered.subarray(len);
					}
					else
					{	this.#buffered = new Uint8Array(this.#buffered.buffer, 0, 0);
					}
					this.#bufferedFor = 0;
				}
			}
			else if (this.#isEof)
			{	// Eof
				controller.close();
			}
			else
			{	// Buffered empty buffer (because the parent reader returned empty item)
				controller.enqueue(this.#buffered);
			}
		}
		else
		{	// Read from the underlying reader
			this.#bufferedFor = -nReader as -1|1;
			let resolve: VoidFunction|undefined;
			if (this.#bufferedFor != this.#cancelledNReader)
			{	this.#promise = new Promise<void>(y => {resolve = y});
			}
			const {value, done} = await this.reader.read(controller.byobRequest.view);
			if (done)
			{	controller.close();
				this.#isEof = true; // Eof
			}
			else
			{	controller.byobRequest.respond(value.byteLength);
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
			}
			resolve?.();
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
{	#promise = Promise.resolve({} as ReadableStreamBYOBReadResult<Uint8Array>);
	#resolve: VoidFunction|undefined;
	#secondReaderOffset = 0;
	#oneCancelled = false;

	constructor(private reader: ReadableStreamBYOBReader)
	{
	}

	async pull(controller: Controller)
	{	if (!this.#resolve)
		{	// First reader
			this.#secondReaderOffset = 0;
			this.#promise = this.reader.read(controller.byobRequest.view);
			const promise2 = this.#oneCancelled ? undefined : new Promise<void>(y => {this.#resolve = y});
			const {value, done} = await this.#promise;
			if (done)
			{	controller.close();
			}
			else
			{	controller.byobRequest.respond(value.byteLength);
			}
			// Wait for the second reader
			if (promise2)
			{	await promise2;
			}
		}
		else
		{	// Second reader
			const {value, done} = await this.#promise; // get the result of the first reader
			if (done)
			{	controller.close();
			}
			else
			{	const {view} = controller.byobRequest;
				const wantLen = value.byteLength - this.#secondReaderOffset;
				const hasLen = view.byteLength;
				const len = Math.min(wantLen, hasLen);
				view.set(value.subarray(this.#secondReaderOffset, this.#secondReaderOffset+len));
				controller.byobRequest.respond(len);
				if (len < wantLen)
				{	// Target buffer is too small, so i return without releasing the first pull (`resolve()`), and wait for another pull from the second reader.
					this.#secondReaderOffset += len;
					return;
				}
			}
			this.#resolve();
			this.#resolve = undefined;
		}
	}

	cancel(reason: Any)
	{	if (!this.#oneCancelled)
		{	this.#oneCancelled = true;
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
