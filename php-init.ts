export var PHP_INIT = String.raw
`<?php

class _PhpDenoBridge extends Exception
{	private const SOCK_NAME = 'unix:///tmp/deno-php-commands-io';
	private const REC_CONST = 0;
	private const REC_GET = 1;
	private const REC_SET = 2;
	private const REC_CLASSSTATIC_CONST = 3;
	private const REC_CLASSSTATIC_GET = 4;
	private const REC_CLASSSTATIC_SET = 5;
	private const REC_CLASSSTATIC_CALL = 6;
	private const REC_CONSTRUCT = 7;
	private const REC_DESTRUCT = 8;
	private const REC_CLASS_GET = 9;
	private const REC_CLASS_SET = 10;
	private const REC_CLASS_CALL = 11;
	private const REC_CALL = 12;
	private const REC_CALL_EVAL = 13;
	private const REC_CALL_ECHO = 14;
	private const REC_CALL_INCLUDE = 15;
	private const REC_CALL_INCLUDE_ONCE = 16;
	private const REC_CALL_REQUIRE = 17;
	private const REC_CALL_REQUIRE_ONCE = 18;

	private static ?int $error_reporting = null;
	private static array $insts = [];
	private static int $inst_id_enum = 0;

	public function __construct($message=null, $code=null, $file=null, $line=null)
	{	parent::__construct($message);
		if ($code !== null) $this->code = $code;
		if ($file) $this->file = $file;
		if ($line !== null) $this->line = $line;
	}

	public static function error_handler($err_code, $err_msg, $file, $line)
	{	if (error_reporting(self::$error_reporting) != 0) // error_reporting returns zero if "@" operator was used
		{	throw new self($err_msg, $err_code, $file, $line);
		}
	}

	private static function get_reflection($class_name)
	{	static $cache = [];
		if (!isset($cache[$class_name]))
		{	$cache[$class_name] = new ReflectionClass($class_name);
		}
		return $cache[$class_name];
	}

	private static function has_static_property($class_name, $prop_name)
	{	static $cache = [];
		if (!isset($cache[$class_name]))
		{	$cache[$class_name] = array_keys(self::get_reflection($class_name)->getStaticProperties());
		}
		return in_array($prop_name, $cache[$class_name]);
	}

	private static function has_constant($class_name, $prop_name)
	{	static $cache = [];
		if (!isset($cache[$class_name]))
		{	$cache[$class_name] = array_keys(self::get_reflection($class_name)->getConstants());
		}
		return in_array($prop_name, $cache[$class_name]);
	}

	private static function eval($code)
	{	return eval($code);
	}

	private static function decode_value($data)
	{	return strlen($data)==0 ? null : json_decode($data);
	}

	private static function decode_ident_value($data, &$ident)
	{	$pos = strpos($data, ' ');
		if ($pos === false)
		{	$ident = $data;
			return null;
		}
		else
		{	$ident = substr($data, 0, $pos);
			return json_decode(substr($data, $pos+1), true);
		}
	}

	private static function decode_ident_ident($data, &$ident_a)
	{	$pos = strpos($data, ' ');
		if ($pos === false)
		{	$ident_a = $data;
			return null;
		}
		else
		{	$ident_a = substr($data, 0, $pos);
			return substr($data, $pos+1);
		}
	}

	private static function decode_ident_ident_value($data, &$ident_a, &$ident_b)
	{	$pos = strpos($data, ' ');
		$ident_a = substr($data, 0, $pos);
		$pos++;
		$pos_2 = strpos($data, ' ', $pos);
		if ($pos_2 === false)
		{	$ident_b = substr($data, $pos);
			return null;
		}
		else
		{	$ident_b = substr($data, $pos, $pos_2-$pos);
			return json_decode(substr($data, $pos_2+1), true);
		}
	}

	private static function encode_value($value)
	{	if ($value !== null)
		{	$value = json_encode($value);
			return pack('l', strlen($value)).$value;
		}
		else
		{	// optimization for null case
			return "\0\0\0\0";
		}
	}

	public static function main()
	{	global $argc, $argv;
		$argc = $_SERVER['argc'];
		$argv = $_SERVER['argv'];
		// Install error handler, that converts E_ERROR to Exception
		self::$error_reporting = error_reporting(); // determine reporting level set by user
		set_error_handler(__CLASS__.'::error_handler', self::$error_reporting);
		// Proceed
		$stdin = fopen('php://stdin', 'r');
		$output = stream_socket_client(self::SOCK_NAME, $errno, $errstr);
		if ($output === false)
		{	exit("stream_socket_client(): errno=$errno $errstr");
		}
		while (!feof($stdin))
		{	try
			{	$len = fread($stdin, 8);
				if (strlen($len) != 8)
				{	if (strlen($len)==0 or $len=="\n" or $len=="\r" or $len=="\r\n")
					{	continue;
					}
					exit; // Fatal error
				}
				list('T' => $record_type, 'L' => $len) = unpack('NT/NL', $len);
				$data = '';
				while ($len > 0)
				{	$read = fread($stdin, $len);
					$data .= $read;
					$len -= strlen($read);
				}
				switch ($record_type)
				{	case self::REC_CONST:
						if (!defined($data))
						{	fwrite($output, "\xFF\xFF\xFF\xFF"); // undefined
						}
						else
						{	$data = constant($data);
							fwrite($output, self::encode_value($data));
						}
						break;
					case self::REC_GET:
						if (!array_key_exists($data, $GLOBALS))
						{	fwrite($output, "\xFF\xFF\xFF\xFF"); // undefined
						}
						else
						{	$data = $GLOBALS[$data];
							fwrite($output, self::encode_value($data));
						}
						break;
					case self::REC_SET:
						$data = self::decode_ident_value($data, $prop_name);
						$GLOBALS[$prop_name] = $data;
						break;
					case self::REC_CLASSSTATIC_CONST:
						$prop_name = self::decode_ident_ident($data, $class_name);
						$data = self::get_reflection($class_name)->getConstant($prop_name);
						if ($data===false and !self::has_constant($class_name, $prop_name))
						{	fwrite($output, "\xFF\xFF\xFF\xFF"); // undefined
						}
						else
						{	fwrite($output, self::encode_value($data));
						}
						break;
					case self::REC_CLASSSTATIC_GET:
						$prop_name = self::decode_ident_ident($data, $class_name);
						try
						{	$data = self::get_reflection($class_name)->getStaticPropertyValue($prop_name);
							fwrite($output, self::encode_value($data));
						}
						catch (Throwable $e)
						{	if (self::has_static_property($class_name, $prop_name))
							{	throw $e;
							}
							fwrite($output, "\xFF\xFF\xFF\xFF"); // undefined
						}
						break;
					case self::REC_CLASSSTATIC_SET:
						$data = self::decode_ident_ident_value($data, $class_name, $prop_name);
						self::get_reflection($class_name)->setStaticPropertyValue($prop_name, $data);
						break;
					case self::REC_CLASSSTATIC_CALL:
						$data = self::decode_ident_ident_value($data, $class_name, $prop_name);
						$data = $data===null ? call_user_func([$class_name, $prop_name]) : call_user_func_array([$class_name, $prop_name], $data);
						fwrite($output, self::encode_value($data));
						break;
					case self::REC_CONSTRUCT:
						$data = self::decode_ident_value($data, $class_name);
						$data = $data===null ? self::get_reflection($class_name)->newInstance() : self::get_reflection($class_name)->newInstanceArgs($data);
						self::$insts[self::$inst_id_enum] = $data;
						fwrite($output, self::encode_value(self::$inst_id_enum++));
						break;
					case self::REC_DESTRUCT:
						unset(self::$insts[$data]);
						break;
					case self::REC_CLASS_GET:
						$prop_name = self::decode_ident_ident($data, $inst_id);
						$data = self::$insts[$inst_id]->$prop_name;
						fwrite($output, self::encode_value($data));
						break;
					case self::REC_CLASS_SET:
						$data = self::decode_ident_ident_value($data, $inst_id, $prop_name);
						self::$insts[$inst_id]->$prop_name = $data;
						break;
					case self::REC_CLASS_CALL:
						$data = self::decode_ident_ident_value($data, $inst_id, $prop_name);
						$data = $data===null ? call_user_func([self::$insts[$inst_id], $prop_name]) : call_user_func_array([self::$insts[$inst_id], $prop_name], $data);
						fwrite($output, self::encode_value($data));
						break;
					case self::REC_CALL:
						$data = self::decode_ident_value($data, $prop_name);
						$data = $data===null ? call_user_func($prop_name) : call_user_func_array($prop_name, $data);
						fwrite($output, self::encode_value($data));
						break;
					case self::REC_CALL_EVAL:
						$data = self::decode_value($data);
						$data = self::eval($data);
						fwrite($output, self::encode_value($data));
						break;
					case self::REC_CALL_ECHO:
						$data = self::decode_value($data);
						foreach ($data as $arg)
						{	echo $arg;
						}
						fwrite($output, "\0\0\0\0");
						break;
					case self::REC_CALL_INCLUDE:
						$data = self::decode_value($data);
						$data = include($data);
						fwrite($output, self::encode_value($data));
						break;
					case self::REC_CALL_INCLUDE_ONCE:
						$data = self::decode_value($data);
						$data = include_once($data);
						fwrite($output, self::encode_value($data));
						break;
					case self::REC_CALL_REQUIRE:
						$data = self::decode_value($data);
						$data = require($data);
						fwrite($output, self::encode_value($data));
						break;
					case self::REC_CALL_REQUIRE_ONCE:
						$data = self::decode_value($data);
						$data = require_once($data);
						fwrite($output, self::encode_value($data));
						break;
				}
			}
			catch (Throwable $e)
			{	$data = json_encode([$e->getFile(), $e->getLine(), $e->getMessage(), $e->getTraceAsString()]);
				fwrite($output, pack('l', -strlen($data)).$data);
			}
			fflush($output);
		}
	}
}

_PhpDenoBridge::main();
?>`;
