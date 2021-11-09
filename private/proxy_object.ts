type ProxyGetterForPath = (prop_name: string) => Promise<any>;
type ProxySetterForPath = (prop_name: string, value: any) => boolean;
type ProxyDeleterForPath = (prop_name: string) => boolean;
type ProxyApplierForPath = (args: IArguments) => any;
type ProxyHasInstanceForPath = (inst: Object) => boolean;
type ProxyIteratorForPath = () => AsyncGenerator<any>;

export function create_proxy
(	path: string[],
	string_tag: string,
	get_getter: (path: string[]) => ProxyGetterForPath,
	get_setter: (path: string[]) => ProxySetterForPath,
	get_deleter: (path: string[]) => ProxyDeleterForPath,
	get_applier: (path: string[]) => ProxyApplierForPath,
	get_constructor: (path: string[]) => ProxyApplierForPath,
	get_has_instance: (path: string[]) => ProxyHasInstanceForPath,
	get_iterator: (path: string[]) => ProxyIteratorForPath,
	alt_symbol_for_string_tag?: Symbol
)
{	return inst(path, {getter: undefined});
	function inst
	(	path: string[],
		parent_getter: {getter: ProxyGetterForPath | undefined}
	): any
	{	let promise: Promise<any> | undefined;
		let for_getter = {getter: undefined};
		let setter: ProxySetterForPath | undefined;
		let deleter: ProxyDeleterForPath | undefined;
		let applier: ProxyApplierForPath | undefined;
		let constructor: ProxyApplierForPath | undefined;
		let has_instance: ProxyHasInstanceForPath | undefined;
		let iterator: ProxyIteratorForPath | undefined;
		return new Proxy
		(	function() {}, // if this is not a function, construct() and apply() will throw error
			{	get(_, prop_name)
				{	if (typeof(prop_name) != 'string')
					{	// case: +path or path+''
						if (prop_name===alt_symbol_for_string_tag || prop_name==Symbol.toStringTag)
						{	return string_tag;
						}
						else if (prop_name == Symbol.hasInstance)
						{	if (!has_instance)
							{	has_instance = get_has_instance(path);
							}
							return has_instance;
						}
						else if (prop_name == Symbol.asyncIterator)
						{	if (!iterator)
							{	iterator = get_iterator(path);
							}
							return iterator;
						}
						throw new Error(`Value must be awaited-for`);
					}
					else if (prop_name=='then' || prop_name=='catch' || prop_name=='finally')
					{	// case: await path
						if (path.length == 0)
						{	return; // not thenable
						}
						if (!parent_getter.getter)
						{	parent_getter.getter = get_getter(path.slice(0, -1));
						}
						if (!promise)
						{	promise = parent_getter.getter(path[path.length-1]);
						}
						if (prop_name == 'then')
						{	return (y: any, n: any) => promise!.then(y, n);
						}
						else if (prop_name == 'catch')
						{	return (n: any) => promise!.catch(n);
						}
						else
						{	return (y: any) => promise!.finally(y);
						}
					}
					else
					{	// case: path.prop_name
						return inst(path.concat([prop_name]), for_getter);
					}
				},
				set(_, prop_name, value) // set static class variable
				{	// case: path.prop_name = value
					if (typeof(prop_name) != 'string')
					{	throw new Error('Cannot use such object like this');
					}
					if (!setter)
					{	setter = get_setter(path);
					}
					return setter(prop_name, value);
				},
				deleteProperty(_, prop_name)
				{	if (typeof(prop_name) != 'string')
					{	throw new Error('Cannot use such object like this');
					}
					if (!deleter)
					{	deleter = get_deleter(path);
					}
					return deleter(prop_name);
				},
				apply(_, proxy, args)
				{	// case: path(args)
					if (!applier)
					{	applier = get_applier(path);
					}
					return applier(args as any);
				},
				construct(_, args) // new Class
				{	// case: new path
					if (!constructor)
					{	constructor = get_constructor(path);
					}
					return constructor(args as any);
				}
			}
		);
	}
}
