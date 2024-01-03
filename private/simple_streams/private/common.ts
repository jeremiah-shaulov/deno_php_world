/**	By default min chunk size will be 1/8 of it.
 **/
export const DEFAULT_AUTO_ALLOCATE_SIZE = 32*1024;

// deno-lint-ignore no-explicit-any
type Any = any;

export type Callbacks =
{	start?(): void | PromiseLike<void>;
	read?(view: Uint8Array): number | null | PromiseLike<number|null>;
	write?(chunk: Uint8Array, canReturnZero: boolean): number | PromiseLike<number>;
	close?(): void | PromiseLike<void>;
	cancel?(reason: Any): void | PromiseLike<void>;
	abort?(reason: Any): void | PromiseLike<void>;
	catch?(reason: Any): void | PromiseLike<void>;
};

export class CallbackAccessor
{	closed: Promise<void>;
	error: Any;
	ready: Promise<void>;
	#callbacks: Callbacks|undefined;
	#cancelCurOp: ((value?: undefined) => void) | undefined;
	#reportClosed: VoidFunction|undefined;
	#reportClosedWithError: ((error: Any) => void) | undefined;

	constructor(callbacks: Callbacks, private useAbortNotCancel: boolean)
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

		if (this.error == undefined)
		{	if (!isCancelOrAbort)
			{	if (callbacks?.close)
				{	try
					{	await callbacks.close();
						reportClosed?.();
					}
					catch (e)
					{	this.error = e;
					}
				}
				else
				{	reportClosed?.();
				}
			}
			else
			{	try
				{	const promise = this.useAbortNotCancel ? callbacks?.abort?.(reason) : callbacks?.cancel?.(reason);
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
				}
			}
		}

		if (this.error != undefined)
		{	if (callbacks?.catch)
			{	try
				{	await callbacks.catch(this.error);
				}
				catch
				{	// ok
				}
			}
			reportClosedWithError?.(this.error);
			throw this.error;
		}
	}
}

export class ReaderOrWriter<SomeCallbackAccessor extends CallbackAccessor>
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
	{	if (this.callbackAccessor)
		{	this.callbackAccessor = undefined;
			this.onRelease();
		}
	}

	[Symbol.dispose]()
	{	this.releaseLock();
	}
}
