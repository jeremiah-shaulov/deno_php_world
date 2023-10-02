const DEFAULT_BUFFER_SIZE = 8*1024;

// deno-lint-ignore no-explicit-any
type Any = any;

export class ReadableStreamOfBytes extends ReadableStream<Uint8Array>
{	#underlyingController: ReadableStreamDefaultController<Uint8Array>;
	#autoAllocateChunkSize: number;
	#startPromise: PromiseLike<void>;
	#pull: ((controller: Controller) => void | PromiseLike<void>) | undefined;

	constructor(underlyingSource?: Source)
	{	const autoAllocateChunkSizeU = underlyingSource?.autoAllocateChunkSize;
		const autoAllocateChunkSize = autoAllocateChunkSizeU && autoAllocateChunkSizeU>0 ? autoAllocateChunkSizeU : DEFAULT_BUFFER_SIZE;
		const start = underlyingSource?.start;
		const pull = underlyingSource?.pull;
		const cancel = underlyingSource?.cancel;
		let underlyingController!: ReadableStreamDefaultController<Uint8Array>;
		let startPromise!: PromiseLike<void>;
		super
		(	{	start(controller)
				{	underlyingController = controller;
					startPromise = start?.(new Controller(underlyingController, autoAllocateChunkSize, new Uint8Array, [])) ?? Promise.resolve();
					return startPromise;
				},
				cancel,
			}
		);
		this.#underlyingController = underlyingController;
		this.#autoAllocateChunkSize = autoAllocateChunkSize;
		this.#startPromise = startPromise;
		this.#pull = pull;
	}

	getReader(options?: {mode?: undefined}): ReadableStreamDefaultReader<Uint8Array>;
	getReader(options: {mode: 'byob'}): ReadableStreamBYOBReader;
	getReader(_options?: {mode?: 'byob'}): ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader
	{	return new Reader(super.getReader(), this.#underlyingController, this.#autoAllocateChunkSize, this.#startPromise, this.#pull);
	}
}

interface Source
{	type?: 'bytes',
	autoAllocateChunkSize?: number;
	start?: (controller: Controller) => void | PromiseLike<void>;
	pull?: (controller: Controller) => void | PromiseLike<void>;
	cancel?: (reason: Any) => void | PromiseLike<void>;
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

class Controller
{	readonly byobRequest: ByobRequest;
	#recycleBuffer = false;

	constructor(private underlyingController: ReadableStreamDefaultController<Uint8Array>, private autoAllocateChunkSize: number, view: Uint8Array|undefined, private buffers: Uint8Array[])
	{	if (!view)
		{	view = buffers.pop() ?? new Uint8Array(autoAllocateChunkSize * 2); // allocate twice size, and try to reuse parts till they become less than the `autoAllocateChunkSize`
			this.#recycleBuffer = true;
		}
		this.byobRequest = new ByobRequest(this, view);
	}

	get desiredSize()
	{	return this.underlyingController.desiredSize;
	}

	close()
	{	this.underlyingController.close();
	}

	enqueue(chunk: Uint8Array)
	{	if (this.#recycleBuffer)
		{	const {view} = this.byobRequest;
			if (chunk.buffer != view.buffer)
			{	this.buffers.push(view);
			}
			else
			{	const end = chunk.byteOffset + chunk.byteLength;
				if (chunk.buffer.byteLength-end >= this.autoAllocateChunkSize)
				{	this.buffers.push(new Uint8Array(chunk.buffer, end));
				}
			}
		}
		this.underlyingController.enqueue(chunk);
	}

	error(error?: Any)
	{	this.underlyingController.error(error);
	}
}

/**	The same as `ReadableStreamBYOBReader`, but it's `read()` stores it's argument (`view`) to be used in `byobRequest` without transferring.
 **/
class Reader
{	#buffers = new Array<Uint8Array>;

	constructor
	(	private parentReader: ReadableStreamDefaultReader<Uint8Array>,
		private underlyingController: ReadableStreamDefaultController<Uint8Array>,
		private autoAllocateChunkSize: number,
		private ongoing: PromiseLike<void>,
		private pull?: (controller: Controller) => void | PromiseLike<void>,
	)
	{
	}

	get closed()
	{	return this.parentReader.closed;
	}

	cancel(reason?: Any)
	{	return this.parentReader.cancel(reason);
	}

	releaseLock()
	{	this.parentReader.releaseLock();
	}

	async read<V extends ArrayBufferView>(view?: V): Promise<ReadableStreamBYOBReadResult<V>>
	{	if (view && !(view instanceof Uint8Array))
		{	throw new Error('Only Uint8Array is supported'); // i always return `Uint8Array`, and it must be `V`
		}
		const {pull} = this;
		if (pull)
		{	this.ongoing = this.ongoing.then
			(	async () =>
				{	try
					{	await pull(new Controller(this.underlyingController, this.autoAllocateChunkSize, view, this.#buffers));
					}
					catch (e)
					{	this.underlyingController.error(e);
					}
				}
			);
		}
		const {value, done} = await this.parentReader.read();
		return {value: value as Any, done};
	}
}
