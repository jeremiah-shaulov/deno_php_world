/**	By default min chunk size will be 1/8 of it.
 **/
export const DEFAULT_AUTO_ALLOCATE_SIZE = 32*1024;

// deno-lint-ignore no-explicit-any
type Any = any;

export type CallbackStart = () => void | PromiseLike<void>;
export type CallbackReadOrWrite = (view: Uint8Array) => number | null | PromiseLike<number|null>;
export type CallbackWrite = (view: Uint8Array) => number | PromiseLike<number>;
export type CallbackClose = () => void | PromiseLike<void>;
export type CallbackCancelOrAbort = (reason: Any) => void | PromiseLike<void>;

export class CallbackAccessor
{	closed: Promise<void>;
	error: Any;
	ongoing = Promise.resolve();
	#reportClosed: VoidFunction|undefined;
	#reportClosedWithError: ((error: Any) => void) | undefined;
	#autoAllocateBuffer: Uint8Array|undefined;

	constructor
	(	private autoAllocateChunkSize: number,
		private autoAllocateMin: number,
		callbackStart: CallbackStart|undefined,
		private callbackReadOrWrite: CallbackReadOrWrite|undefined,
		private callbackClose: CallbackClose|undefined,
		private callbackCancelOrAbort: CallbackCancelOrAbort|undefined,
	)
	{	this.closed = new Promise<void>
		(	(y, n) =>
			{	this.#reportClosed = y;
				this.#reportClosedWithError = n;
			}
		);
		this.closed.catch(() => {});
		try
		{	const startPromise = callbackStart?.();
			if (startPromise)
			{	this.ongoing = this.ongoing.then(() => startPromise).then
				(	undefined,
					e =>
					{	this.error = e;
						return this.close();
					}
				);
			}
		}
		catch (e)
		{	this.error = e;
			this.ongoing = this.close();
		}
	}

	useCallback<T>(callback: (callbackReadOrWrite: CallbackReadOrWrite) => T | PromiseLike<T>)
	{	if (this.callbackReadOrWrite)
		{	const promise = this.ongoing.then
			(	async () =>
				{	if (this.callbackReadOrWrite)
					{	try
						{	return await callback(this.callbackReadOrWrite);
						}
						catch (e)
						{	this.error = e;
							await this.close();
							throw e;
						}
					}
					else if (this.error)
					{	throw this.error;
					}
				}
			);
			this.ongoing = promise.then(undefined, () => {});
			return promise;
		}
		else if (this.error)
		{	throw this.error;
		}
	}

	read(view?: Uint8Array)
	{	return this.useCallback
		(	async callbackReadOrWrite =>
			{	let isUserSuppliedBuffer = true;
				if (!view)
				{	view = this.#autoAllocateBuffer ?? new Uint8Array(this.autoAllocateChunkSize);
					this.#autoAllocateBuffer = undefined;
					isUserSuppliedBuffer = false;
				}
				const nRead = await callbackReadOrWrite(view);
				if (!isUserSuppliedBuffer)
				{	const end = view.byteOffset + (nRead ?? 0);
					if (view.buffer.byteLength-end >= this.autoAllocateMin)
					{	this.#autoAllocateBuffer = new Uint8Array(view.buffer, end);
					}
				}
				if (nRead == null)
				{	await this.close();
				}
				else
				{	return view.subarray(0, nRead);
				}
			}
		);
	}

	write(view: Uint8Array)
	{	return this.useCallback(callbackReadOrWrite => callbackReadOrWrite(view));
	}

	async cancelOrAbort(reason: Any)
	{	const {callbackCancelOrAbort} = this;
		await this.close();
		if (callbackCancelOrAbort)
		{	const promise = this.ongoing.then(() => callbackCancelOrAbort(reason), () => {});
			this.ongoing = promise;
			await promise;
		}
	}

	async close()
	{	const {callbackClose} = this;
		const reportClosed = this.#reportClosed;
		const reportClosedWithError = this.#reportClosedWithError;

		this.callbackClose = undefined; // don't call `close` anymore
		this.callbackReadOrWrite = undefined; // don't call `read` anymore
		this.callbackCancelOrAbort = undefined; // don't call `cancel` anymore
		this.#reportClosed = undefined;
		this.#reportClosedWithError = undefined;

		if (callbackClose)
		{	try
			{	await callbackClose();
			}
			catch (e)
			{	if (!this.error)
				{	this.error = e;
				}
			}
		}

		if (this.error != undefined)
		{	reportClosedWithError?.(this.error);
		}
		else
		{	reportClosed?.();
		}
	}
}

export class ReaderOrWriter
{	constructor(protected callbackAccessor: CallbackAccessor|undefined, private onRelease: VoidFunction)
	{
	}

	protected getCallbackAccessor()
	{	const {callbackAccessor} = this;
		if (!callbackAccessor)
		{	throw new Error('This object is detached');
		}
		return callbackAccessor;
	}

	get closed()
	{	return !this.callbackAccessor ? Promise.resolve() : this.callbackAccessor.closed;
	}

	releaseLock()
	{	this.callbackAccessor = undefined;
		this.onRelease();
	}
}
