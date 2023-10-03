const DEFAULT_BUFFER_SIZE = 8*1024;

// deno-lint-ignore no-explicit-any
type Any = any;

type StartOrPull = (controller: Controller) => void | PromiseLike<void>;

interface Source
{	type?: 'bytes',
	autoAllocateChunkSize?: number;
	start?: StartOrPull;
	pull?: StartOrPull;
	cancel?: (reason: Any) => void | PromiseLike<void>;
}

export class ReadableStreamOfBytes extends ReadableStream<Uint8Array>
{	#autoAllocateChunkSize: number;
	#puller: Puller;

	constructor(underlyingSource?: Source)
	{	const autoAllocateChunkSizeU = underlyingSource?.autoAllocateChunkSize;
		const autoAllocateChunkSize = autoAllocateChunkSizeU && autoAllocateChunkSizeU>0 ? autoAllocateChunkSizeU : DEFAULT_BUFFER_SIZE;
		const start = underlyingSource?.start;
		const cancel = underlyingSource?.cancel;
		const pull = underlyingSource?.pull;
		let puller!: Puller;
		super
		(	{	start(controller)
				{	puller = new Puller(autoAllocateChunkSize, pull, controller);
					return puller.start(start);
				},
				cancel: (reason) =>
				{	this.#puller.cancelled();
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
			let chunkSize = this.#autoAllocateChunkSize;
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

class Puller
{	#ongoing: PromiseLike<void> = Promise.resolve();
	#wantToPull = 0;
	#nQueued = 0;
	#recycledBuffer: Uint8Array|undefined;

	constructor
	(	private autoAllocateChunkSize: number,
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
				{	if (this.#wantToPull > this.#nQueued)
					{	try
						{	let recycleBuffer = false;
							if (!view)
							{	view = this.#recycledBuffer ?? new Uint8Array(this.autoAllocateChunkSize * 2); // allocate twice size, and try to reuse parts till they become less than the `autoAllocateChunkSize`
								this.#recycledBuffer = undefined;
								recycleBuffer = true;
							}
							await this.underlyingPull?.(new Controller(this, view, recycleBuffer));
						}
						catch (e)
						{	this.underlyingPull = undefined;
							this.underlyingController.error(e);
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
				if (chunk.buffer.byteLength-end >= this.autoAllocateChunkSize)
				{	this.#recycledBuffer = new Uint8Array(chunk.buffer, end);
				}
			}
		}
		this.#nQueued++;
		this.underlyingController.enqueue(chunk);
	}

	close()
	{	this.underlyingPull = undefined;
		this.underlyingController.close();
	}

	error(error?: Any)
	{	this.underlyingPull = undefined;
		this.underlyingController.error(error);
	}

	cancelled()
	{	this.underlyingPull = undefined;
	}
}

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

class ByobRequest
{	constructor(private controller: Controller, readonly view: Uint8Array)
	{
	}

	respond(bytesWritten: number)
	{	const {view} =  this;
		this.controller.enqueue(new Uint8Array(view.buffer, view.byteOffset, bytesWritten));
	}

	respondWithNewView(view: ArrayBufferView)
	{	this.controller.enqueue(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
	}
}

/**	The same as `ReadableStreamBYOBReader`, but it's `read()` stores it's argument (`view`) to be used in `byobRequest` without transferring.
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
		this.puller.pull(view);
		const {value, done} = await this.underlyingReader.read();
		return {value: value as Any, done};
	}
}
