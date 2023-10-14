/**	By default min chunk size will be 1/8 of it.
 **/
export const DEFAULT_AUTO_ALLOCATE_SIZE = 32*1024;

// deno-lint-ignore no-explicit-any
type Any = any;

type CallbackStartOrCloseOrFlush = () => void | PromiseLike<void>;
type CallbackReadOrWrite<Result> = (view: Uint8Array) => Result | PromiseLike<Result>;
type CallbackCancelOrAbort = (reason: Any) => void | PromiseLike<void>;

export type Callbacks =
{	start?: CallbackStartOrCloseOrFlush;
	read?: CallbackReadOrWrite<number|null>;
	write?: CallbackReadOrWrite<number>;
	close?: CallbackStartOrCloseOrFlush;
	cancel?: CallbackCancelOrAbort;
	abort?: CallbackCancelOrAbort;
};

export class CallbackAccessor<Result>
{	closed: Promise<void>;
	error: Any;
	ready: Promise<void>;
	#callbacks: Callbacks|undefined;
	#cancelCurOp: ((value?: undefined) => void) | undefined;
	#reportClosed: VoidFunction|undefined;
	#reportClosedWithError: ((error: Any) => void) | undefined;

	constructor(callbacks: Callbacks)
	{	this.#callbacks = callbacks;
		this.closed = new Promise<void>
		(	(y, n) =>
			{	this.#reportClosed = y;
				this.#reportClosedWithError = n;
			}
		);
		this.closed.then(undefined, () => {});
		const startPromise = callbacks.start?.(); // can throw before returning promise, and this should break the constructor, because this is the behavior of `ReadableStream`
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

	useCallbacks<T>(useCallbacks: (callbacks: Callbacks) => T | PromiseLike<T>)
	{	if (this.#callbacks)
		{	const promise = this.ready.then
			(	() =>
				{	const callbacks = this.#callbacks;
					if (callbacks)
					{	try
						{	const resultOrPromise = useCallbacks(callbacks);
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
	{	const callbacks = this.#callbacks;
		let cancelCurOp = this.#cancelCurOp;
		const reportClosed = this.#reportClosed;
		const reportClosedWithError = this.#reportClosedWithError;

		this.#callbacks = undefined; // don't call callbacks anymore
		this.#cancelCurOp = undefined;
		this.#reportClosed = undefined;
		this.#reportClosedWithError = undefined;

		if (this.error != undefined)
		{	reportClosedWithError?.(this.error);
		}
		else
		{	if (!isCancelOrAbort)
			{	if (callbacks?.close)
				{	try
					{	await callbacks.close();
					}
					catch (e)
					{	this.error = e;
					}
				}
				reportClosed?.();
			}
			else
			{	try
				{	const promise = callbacks?.cancel ? callbacks.cancel(reason) : callbacks?.abort?.(reason);
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
