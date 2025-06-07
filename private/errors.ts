export class InterpreterExitError extends Error
{	constructor(public override message: string, public code: number)
	{	super(message);
	}
}

export class InterpreterError extends Error
{	constructor(public override message: string, public fileName: string, public lineNumber: number, public phpStack: string, for_stack?: Error)
	{	super(message);
		let stack = this.stack + '';
		if (phpStack)
		{	let header_to = stack.indexOf('\r');
			if (header_to == -1)
			{	header_to = stack.indexOf('\n');
			}
			if (header_to != -1)
			{	/*	i expect `trace` to be like:

					#0 /home/jeremiah/dev/deno/deno_php_world/php/deno-php-world.php(385) : eval()'d code(1): f1()
					#1 /home/jeremiah/dev/deno/deno_php_world/php/deno-php-world.php(385) : eval()'d code(1): f2()
					#2 /home/jeremiah/dev/deno/deno_php_world/php/deno-php-world.php(385) : eval()'d code(1): f3()
					#3 /home/jeremiah/dev/deno/deno_php_world/php/deno-php-world.php(385) : eval()'d code(1): f4()
					#4 /home/jeremiah/dev/deno/deno_php_world/php/deno-php-world.php(385) : eval()'d code(1): f5()
					#5 /home/jeremiah/dev/deno/deno_php_world/php/deno-php-world.php(385) : eval()'d code(1): f6()
					#6 /home/jeremiah/dev/deno/deno_php_world/php/deno-php-world.php(385) : eval()'d code(1): f7()
					#7 /home/jeremiah/dev/deno/deno_php_world/php/deno-php-world.php(385) : eval()'d code(1): f8()
					#8 /home/jeremiah/dev/deno/deno_php_world/php/deno-php-world.php(385) : eval()'d code(1): f9()
					#9 /home/jeremiah/dev/deno/deno_php_world/php/deno-php-world.php(385) : eval()'d code(1): f10()
					#10 /home/jeremiah/dev/deno/deno_php_world/php/deno-php-world.php(849): f11()
					#11 /home/jeremiah/dev/deno/deno_php_world/php/deno-php-world.php(955): DenoWorldMain::events_q()
					#12 /home/jeremiah/dev/deno/deno_php_world/php/deno-php-world.php(959): DenoWorldMain::main()
					#13 {main}

					i want to convert it from PHP form to V8, and prepend it to `stack`
				 */
				let trace_conv = '';
				let from = 0;
				while (true)
				{	from = phpStack.indexOf(' ', from);
					if (from == -1)
					{	break;
					}
					from++; // skip ' '
					let pos = phpStack.indexOf(':', from);
					if (pos == -1)
					{	break;
					}
					let pos_2 = pos;
					while (phpStack.charAt(pos_2-1) == ' ')
					{	pos_2--; // skip space before :
					}
					let filename, line_no='';
					if (phpStack.charAt(pos_2-1) != ')')
					{	filename = phpStack.slice(from, pos_2);
					}
					else
					{	let pos_3 = phpStack.lastIndexOf('(', pos_2-2);
						if (pos_3==-1 || pos_3<from)
						{	break;
						}
						line_no = ':'+phpStack.slice(pos_3+1, pos_2-1); // between ( and )
						while (phpStack.charAt(pos_3-1) == ' ')
						{	pos_3--; // skip space before (
						}
						filename = phpStack.slice(from, pos_3);
					}
					pos++; // skip ':'
					while (phpStack.charAt(pos) == ' ')
					{	pos++; // skip space after :
					}
					from = pos;
					pos = phpStack.indexOf('\r', from);
					if (pos == -1)
					{	pos = phpStack.indexOf('\n', from);
					}
					if (pos == -1)
					{	pos = phpStack.length;
					}
					const info = phpStack.slice(from, pos);
					trace_conv += `\n    at ${info} (${filename}${line_no})`;
					from = pos + 1;
					if (phpStack.charAt(from) == '\n')
					{	from++;
					}
				}
				stack = stack.slice(0, header_to) + trace_conv + stack.slice(header_to);
			}
		}
		if (for_stack?.stack)
		{	let pos = for_stack.stack.indexOf('\r');
			if (pos == -1)
			{	pos = for_stack.stack.indexOf('\n');
			}
			if (pos != -1)
			{	stack += for_stack.stack.slice(pos);
			}
		}
		this.stack = stack;
	}
}
