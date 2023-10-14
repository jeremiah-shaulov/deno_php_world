/**	By default min chunk size will be 1/8 of it.
 **/
export const DEFAULT_AUTO_ALLOCATE_SIZE = 32*1024;

// deno-lint-ignore no-explicit-any
type Any = any;

type CallbackStartOrCloseOrFlush = () => void | PromiseLike<void>;
type CallbackReadOrWriteOrTransform<Result> = (view: Uint8Array) => Result | PromiseLike<Result>;
type CallbackCancelOrAbort = (reason: Any) => void | PromiseLike<void>;

export class CallbackAccessor<Result>
{	closed: Promise<void>;
	error: Any;
	ready: Promise<void>;
	#cancelCurOp: ((value?: undefined) => void) | undefined;
	#reportClosed: VoidFunction|undefined;
	#reportClosedWithError: ((error: Any) => void) | undefined;

	constructor
	(	callbackStart: CallbackStartOrCloseOrFlush|undefined,
		private callbackReadOrWrite: CallbackReadOrWriteOrTransform<Result> | undefined,
		private callbackClose: CallbackStartOrCloseOrFlush|undefined,
		private callbackCancelOrAbort: CallbackCancelOrAbort|undefined,
	)
	{	this.closed = new Promise<void>
		(	(y, n) =>
			{	this.#reportClosed = y;
				this.#reportClosedWithError = n;
			}
		);
		this.closed.then(undefined, () => {});
		const startPromise = callbackStart?.(); // can throw before returning promise, and this should break the constructor, because this is the behavior of `ReadableStream`
		if (startPromise)
		{	this.ready = new Promise<void>
			(	y =>
				{	this.#cancelCurOp = y;
					startPromise.then
					(	y,
						e =>
						{	this.error = e;
							this.close().then(y, y);
						}
					);
				}
			);
		}
		else
		{	this.ready = Promise.resolve();
		}
	}

	useCallback<T>(useCallback: (callbackReadOrWrite: (view: Uint8Array) => Result | PromiseLike<Result>) => T | PromiseLike<T>)
	{	if (this.callbackReadOrWrite)
		{	const promise = this.ready.then
			(	() =>
				{	const {callbackReadOrWrite} = this;
					if (callbackReadOrWrite)
					{	try
						{	const resultOrPromise = useCallback(callbackReadOrWrite);
							if (typeof(resultOrPromise)=='object' && resultOrPromise!=null && 'then' in resultOrPromise)
							{	return new Promise<T | undefined>
								(	(y, n) =>
									{	this.#cancelCurOp = y;
										resultOrPromise.then
										(	y,
											e =>
											{	this.error = e;
												return this.close().then(() => n(e), () => n(e));
											}
										);
									}
								);
							}
							else
							{	return resultOrPromise;
							}
						}
						catch (e)
						{	this.error = e;
							return this.close().then(() => Promise.reject(e), () => Promise.reject(e));
						}
					}
					else if (this.error != undefined)
					{	throw this.error;
					}
				}
			);
			this.ready = promise.then(undefined, () => {});
			return promise;
		}
		else if (this.error != undefined)
		{	throw this.error;
		}
	}

	async close(isCancelOrAbort=false, reason?: Any)
	{	const {callbackClose, callbackCancelOrAbort} = this;
		let cancelCurOp = this.#cancelCurOp;
		const reportClosed = this.#reportClosed;
		const reportClosedWithError = this.#reportClosedWithError;

		this.callbackClose = undefined; // don't call `close` anymore
		this.callbackReadOrWrite = undefined; // don't call `read` anymore
		this.callbackCancelOrAbort = undefined; // don't call `cancel` anymore
		this.#cancelCurOp = undefined;
		this.#reportClosed = undefined;
		this.#reportClosedWithError = undefined;

		if (this.error != undefined)
		{	reportClosedWithError?.(this.error);
		}
		else
		{	if (!isCancelOrAbort)
			{	if (callbackClose)
				{	try
					{	await callbackClose();
					}
					catch (e)
					{	this.error = e;
					}
				}
				reportClosed?.();
			}
			else
			{	try
				{	const promise = callbackCancelOrAbort?.(reason);
					cancelCurOp?.();
					cancelCurOp = undefined;
					reportClosed?.();
					if (promise)
					{	await promise;
					}
				}
				catch (e)
				{	this.error = e;
					cancelCurOp?.();
					throw e;
				}
			}
		}
	}
}

export class ReaderOrWriter<SomeCallbackAccessor extends CallbackAccessor<unknown>>
{	constructor(protected callbackAccessor: SomeCallbackAccessor|undefined, private onRelease: VoidFunction)
	{
	}

	protected getCallbackAccessor()
	{	const {callbackAccessor} = this;
		if (!callbackAccessor)
		{	throw new TypeError('Reader or writer has no associated stream.');
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
