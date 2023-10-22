This library is reimplementation of built-in [ReadableStream](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream),
[WritableStream](https://developer.mozilla.org/en-US/docs/Web/API/WritableStream) and
[TransformStream](https://developer.mozilla.org/en-US/docs/Web/API/TransformStream) that specializes on byte streams, that likes to reuse buffers,
doesn't like to [transfer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/ArrayBuffer/transfer) buffers,
and has simplified API.

To make data stream you need to implement the following interface:

```ts
interface Source
{	/** Reads up to `p.byteLength` bytes into `p`. It resolves to the number of
		bytes read (`0` < `n` <= `p.byteLength`) and rejects if any error
		encountered. Even if `read()` resolves to `n` < `p.byteLength`, it may
		use all of `p` as scratch space during the call. If some data is
		available but not `p.byteLength` bytes, `read()` conventionally resolves
		to what is available instead of waiting for more.

		When `read()` encounters end-of-file condition, it resolves to EOF
		(`null`).

		When `read()` encounters an error, it rejects with an error.

		Callers should always process the `n` > `0` bytes returned before
		considering the EOF (`null`). Doing so correctly handles I/O errors that
		happen after reading some bytes and also both of the allowed EOF
		behaviors.

		Implementations should not retain a reference to `p`.
	 **/
	read(p: Uint8Array): Promise<number|null> | number | null;
}
```
Maybe this resembles something familiar to you. Anyway if you implement this interface, you can create a readable stream from it.

```ts
const rdStream = new RdStream
(	{	async read(p)
		{	// ...
			return p.byteLength; // or less
		}
	}
);
```

And the same with writable streams:

```ts
const wrStream = new WrStream
(	{	async write(p)
		{	// ...
			return p.byteLength; // or less
		}
	}
);
```

## class RdStream

This class extends [ReadableStream](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream).

#### Constructor:

```ts
constructor(source: Source);

type Source =
{	/**	If undefined or non-positive number, will use predefined default value (like 32 KiB) when allocating buffers.
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
```

In the Source `read()` is mandatory method. To indicate EOF it can return `0` or `null`.
It can return result asynchronously (`Promise` object) or synchronously (number or null result).

#### Properties:

- **locked**

```ts
readonly locked: boolean;
```

When somebody wants to start reading this stream, he calls `rdStream.getReader()`, and after this call the stream becomes locked.
Further calls to `rdStream.getReader()` will throw error till the reader is released (`reader.releaseLock()`).

Other operations that read the stream (like `rdStream.pipeTo()`) also lock it (internally they get a reader, and later release it).

#### Methods:

- **getReader**

```ts
getReader(options?: {mode?: undefined}): ReadableStreamDefaultReader<Uint8Array>;
getReader(options: {mode: 'byob'}): ReadableStreamBYOBReader;
```
Returns object that allows to read data from the stream.
The stream becomes locked till this reader is released by calling `reader.releaseLock()`.

If the stream is already locked, this method throws error.

- **getReaderWhenReady**

```ts
getReaderWhenReady(options?: {mode?: undefined}): Promise<ReadableStreamDefaultReader<Uint8Array>>;
getReaderWhenReady(options: {mode: 'byob'}): Promise<ReadableStreamBYOBReader>;
```
Like `rdStream.getReader()`, but waits for the stream to become unlocked before returning the reader (and so locking it again).

If you actually don't need the reader, but just want to catch the moment when the stream unlocks, you can do:

```ts
(await rdStream.getReaderWhenReady()).releaseLock();
// here you can immediately (without awaiting any promises) call `pipeTo()`, or something else
```

- **cancel**

```ts
cancel(reason?: any): Promise<void>;
```
Tells to discard further data in the stream.
This leads to calling `source.cancel(reason)` that must implement the actual behavior.

In contrast to `ReadableStream.cancel()`, this method works even if the stream is locked, cancelling current read operation.

- **[Symbol.asyncIterator], values**

```ts
[Symbol.asyncIterator](options?: {preventCancel?: boolean});
values(options?: {preventCancel?: boolean});
```
Allows you to iterate this stream yielding `Uint8Array` data chunks.

- **tee**

```ts
tee(options?: {requireParallelRead?: boolean}): [RdStream, RdStream];
```
Splits the stream to 2, so the rest of the data can be read from both of the resulting streams.

If you'll read from one stream faster than from another, or will not read at all from one of them,
the default behavior is to buffer the data.

If `requireParallelRead` option is set, the buffering will be disabled,
and parent stream will suspend after each item, till it's read by both of the child streams.
In this case if you read and await from the first stream, without previously starting reading from the second,
this will cause a deadlock situation.

- **pipeTo**

```ts
pipeTo(dest: WritableStream<Uint8Array>, options?: PipeOptions): Promise<void>;

type PipeOptions =
{	/**	Don't close `dest` when this readable stream reaches EOF.
	 **/
	preventClose?: boolean;

	/**	Don't abort `dest` when this readable stream enters error state.
	 **/
	preventAbort?: boolean;

	/**	Don't cancel this readable stream, if couldn't write to `dest`.
	 **/
	preventCancel?: boolean;

	/**	Allows to interrupt piping operation.
		The same effect can be reached by aborting the `dest` writable stream.
	 **/
	signal?: AbortSignal;
};
```
Pipe data from this stream to `dest` writable stream (that can be built-in `WritableStream<Uint8Array>` or `WrStream`).

If the data is piped to EOF without error, the source readable stream is closed as usual (`close()` callback is called on `Source`),
and the writable stream will be closed unless `preventClose` option is set.

If destination closes or enters error state, then `pipeTo()` throws exception.
But then `pipeTo()` can be called again to continue piping the rest of the stream to another destination (including previously buffered data).

- **pipeThrough**

```ts
pipeThrough<T, W extends WritableStream<Uint8Array>, R extends ReadableStream<T>>
(	transform: Transform<W, R>,
	options?: PipeOptions
): R;

type Transform<W extends WritableStream<Uint8Array>, R extends ReadableStream<unknown>> =
{	readonly writable: W;
	readonly readable: R;

	/**	If this value is set to a positive integer, `rdStream.pipeThrough()` will use buffer of this size during piping.
		Practically this affects maximum chunk size in `transform(writer, chunk)` callback.
		If that callback returns `0` indicating that it wants more bytes, it will be called again with a larger chunk, till the chunk size reaches `overrideAutoAllocateChunkSize`.
		Then, if it still returns `0`, an error is thrown.
	 **/
	readonly overrideAutoAllocateChunkSize?: number;
};
```
Uses `rdStream.pipeTo()` to pipe the data to transformer's writable stream, and returns transformer's readable stream.

The transformer can be an instance of built-in `TransformStream<Uint8Array, unknown>`, `TrStream`, or any other `writable/readable` pair.

- **read**

```ts
read(view: Uint8Array): Promise<number | null>;
```
Ex-`Deno.Reader` implementation for this object.
It gets a reader (locks the stream), reads, and then releases the reader (unlocks the stream).
It returns number of bytes loaded to the `view`, or `null` on EOF.

- **uint8Array**

```ts
uint8Array(): Promise<Uint8Array>;
```
Reads the whole stream to memory.

- **text**

```ts
text(label?: string, options?: TextDecoderOptions): Promise<string>;
```
Reads the whole stream to memory, and converts it to string, just as `TextDecoder.decode()` does.

#### Static methods:

- **from**

```ts
static from<R>(source: AsyncIterable<R> | Iterable<R | PromiseLike<R>>): ReadableStream<R> & RdStream
```
Converts iterable of `Uint8Array` to `RdStream`.
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

## class WrStream

This class extends [WritableStream](https://developer.mozilla.org/en-US/docs/Web/API/WritableStream).

#### Constructor:

```ts
constructor(sink: Sink);

type Sink =
{	/**	This callback is called immediately during `WrStream` object creation.
		When it's promise resolves, i start to call `write()` as response to `writer.write()`.
		Only one call is active at each moment, and next calls wait for previous calls to complete.

		At the end one of `close()`, `abort(reason)` or `catch(error)` is called.
		- `close()` if caller called `writer.close()` to terminate the stream.
		- `abort()` if caller called `wrStream.abort(reason)` or `writer.abort(reason)`.
		- `catch()` if `write()` thrown exception or returned a rejected promise.
	 **/
	start?(): void | PromiseLike<void>;

	write(chunk: Uint8Array, canRedo: boolean): number | PromiseLike<number>;
	close?(): void | PromiseLike<void>;
	abort?(reason: Any): void | PromiseLike<void>;
	catch?(reason: Any): void | PromiseLike<void>;
};
```

In the Sink `write()` is mandatory method.
It can return result asynchronously (`Promise` object) or synchronously (number result).

#### Properties:

- **locked**

```ts
readonly locked: boolean;
```

When somebody wants to start writing to this stream, he calls `wrStream.getReader()`, and after this call the stream becomes locked.
Further calls to `wrStream.getReader()` will throw error till the writer is released (`writer.releaseLock()`).

#### Methods:
