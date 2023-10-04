// TODO: new enqueued is passed back to read(b)

const DEFAULT_BUFFER_SIZE = 8*1024;

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
	#puller: Puller;

	constructor(underlyingSource?: Source)
	{	const autoAllocateChunkSizeU = underlyingSource?.autoAllocateChunkSize;
		const autoAllocateChunkSize = autoAllocateChunkSizeU==undefined || autoAllocateChunkSizeU<0 ? DEFAULT_BUFFER_SIZE : autoAllocateChunkSizeU;
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
		this.#puller = puller;
	}

	getReader(options?: {mode?: undefined}): ReadableStreamDefaultReader<Uint8Array>;
	getReader(options: {mode: 'byob'}): ReadableStreamBYOBReader;
	getReader(_options?: {mode?: 'byob'}): ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader
	{	return new Reader(super.getReader(), this.#puller);
	}

	async uint8Array()
	{	const reader = this.getReader({mode: 'byob'});
		try
		{	const chunks = new Array<Uint8Array>;
			let totalLen = 0;
			let chunkSize = this.#autoAllocateChunkSize || DEFAULT_BUFFER_SIZE;
			const readTo = chunkSize - (chunkSize >> 3);
			while (true)
			{	let chunk = new Uint8Array(chunkSize);
				while (chunk.byteLength >= readTo)
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
{	readonly byobRequest: ByobRequest;

	constructor(private puller: Puller, view: Uint8Array, private recycleBuffer: boolean)
	{	this.byobRequest = new ByobRequest(this, view);
	}

	get desiredSize()
	{	return this.byobRequest.view.byteLength;
	}

	enqueue(chunk: Uint8Array)
	{	this.puller.enqueue(chunk, this.byobRequest.view, this.recycleBuffer);
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
	{	puller.startReader();
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

	startReader()
	{	this.#wantToPull = 0;
	}

	pull(view?: Uint8Array)
	{	if (this.underlyingPull)
		{	this.#wantToPull++;
			this.#ongoing = this.#ongoing.then
			(	async () =>
				{	if (this.underlyingPull && this.#wantToPull>this.#nQueued)
					{	try
						{	let recycleBuffer = false;
							if (!view)
							{	view = this.#recycledBuffer ?? new Uint8Array(this.autoAllocateChunkSize);
								this.#recycledBuffer = undefined;
								recycleBuffer = true;
							}
							const prevNQueued = this.#nQueued;
							await this.underlyingPull(new Controller(this, view, recycleBuffer));
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

	enqueue(chunk: Uint8Array, view: Uint8Array, recycleBuffer: boolean)
	{	if (recycleBuffer)
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
