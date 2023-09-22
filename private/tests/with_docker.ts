const decoder = new TextDecoder;

export async function system(cmd: string, args: string[], stderr: 'inherit'|'null'='inherit')
{	const h = new Deno.Command(cmd, {args, stdout: 'piped', stderr}).spawn();
	try
	{	const output = await h.output();
		return decoder.decode(output.stdout);
	}
	catch (e)
	{	try
		{	h.kill();
		}
		catch
		{	// ok
		}
		throw e;
	}
}

async function stop_left_running(container_name_prefix: string)
{	const res = await system('docker', ['container', 'ls', '--filter', `name=^${container_name_prefix}_`]);
	const lines = res.split(/[\r\n]+/);
	lines.shift(); // remove header line
	for (const line of lines)
	{	const container_name = line.match(/(\S*)\s*$/)![0];
		if (container_name)
		{	try
			{	console.log(`%cStopping container ${container_name}`, 'color:blue');
				await system('docker', ['stop', container_name]);
			}
			catch (e)
			{	console.error(e);
			}
		}
	}
}

export async function with_docker(image_name: string, container_name_prefix: string, container_internal_port: number, params: string[], cb: (container_name: string, external_port: number) => Promise<unknown>)
{	await stop_left_running(container_name_prefix);
	const container_name = container_name_prefix + '_' + Math.floor(Math.random() * 256);
	// Format command line
	const args = ['run', '--rm', '--name', container_name, '--add-host', 'host.docker.internal:host-gateway', '-p', container_internal_port+''];
	for (const p of params)
	{	args.push(p);
	}
	args.push(image_name);
	// Run
	console.log(`%s: %cStarting`, image_name, 'color:blue');
	const process = new Deno.Command('docker', {args}).spawn();
	// Work with it, and finally drop
	try
	{	// Find out port number
		let external_port = '';
		let error;
		for (let i=0; i<300; i++) // 300 half-seconds (150 seconds)
		{	await new Promise(y => setTimeout(y, 500));
			try
			{	const port_desc = await system('docker', ['port', container_name], 'null');
				const m = port_desc.match(/:(\d+)[\r\n]/);
				if (m)
				{	external_port = m[1];
					break;
				}
			}
			catch (e)
			{	error = e;
			}
		}
		if (!external_port)
		{	throw error ?? new Error(`Cannot find out docker port`);
		}
		// Call the cb
		console.log(`%s: %cReady`, image_name, 'color:blue');
		await cb(container_name, Number(external_port));
	}
	finally
	{	// Drop the container
		console.log(`%s: %cStopping`, image_name, 'color:blue');
		try
		{	await system('docker', ['stop', container_name]);
		}
		finally
		{	try
			{	process.kill();
			}
			catch
			{	// ok
			}
			console.log(`%s: %cDone`, image_name, 'color:blue');
		}
	}
}
