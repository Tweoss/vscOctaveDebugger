/*******************************************************************************
Copyright 2018 Paulo Silva

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 ******************************************************************************/
import {
	Logger, logger,
	DebugSession, LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent,
	Thread, StackFrame, Scope, Breakpoint, Variable
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import * as Constants from './Constants';
import { Runtime } from './Runtime';
import { Breakpoints } from './Control/Breakpoints';
import { StackFramesManager } from './Control/StackFramesManager';
import { Variables } from './Variables/Variables';
import { Variable as OctaveVariable } from './Variables/Variable';
import { Scalar } from './Variables/Scalar';
import { Matrix } from './Variables/Matrix';
import { Struct } from './Variables/Struct';
import { Scope as OctaveScope } from './Variables/Scope';


//******************************************************************************
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
}


//******************************************************************************
class OctaveDebugSession extends LoggingDebugSession {
	private static THREAD_ID = 1;
	private _runtime: Runtime;
	private _stackManager: StackFramesManager;
	private _runCallback: () => void;


	//**************************************************************************
	public constructor() {
		super(Constants.MODULE_NAME + ".txt");

		this._stackManager = new StackFramesManager();

		// In matlab every index starts at 1
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);

		this.setupVariables();
		this.setupRuntime();
	}


	//**************************************************************************
	private setupVariables(): void {
		// These are the supported variables.
		Variables.register(new Struct()); // 'scalar structs' only.
		Variables.register(new Matrix()); // Any array.
		// Everything not listed above is treated as a Scalar (string).
		Variables.registerFallback(new Scalar());
	}


	//**************************************************************************
	private setupRuntime() {
		this._runtime = new Runtime(Constants.DEFAULT_EXECUTABLE);

		this._runtime.on('end', () => {
			this.sendEvent(new TerminatedEvent());
		});

		this._runtime.addEventHandler((line: string) => {
			// TODO: don't need to know file nor line... Use string comparison instead?
			const match = line.match(/^stopped in (.*?) at line (\d+)$/);
			if(match !== null && match.length > 2) {
				this.sendEvent(new StoppedEvent('breakpoint', OctaveDebugSession.THREAD_ID));
				return true; // Event handled. Stop processing.
			}

			return false; // Event not handled. Pass the event to the next handler.
		});
	}


	//**************************************************************************
	protected initializeRequest(response: DebugProtocol.InitializeResponse,
								args: DebugProtocol.InitializeRequestArguments): void
	{
		this.sendEvent(new InitializedEvent());

		response.body = response.body || {};
		response.body.supportsConfigurationDoneRequest = true;
		response.body.supportsEvaluateForHovers = true;
		response.body.supportsConditionalBreakpoints = true;
		response.body.supportsHitConditionalBreakpoints = true;
		response.body.supportsSetVariable = true;
		response.body.supportsStepBack = false;

		this.sendResponse(response);
	}


	//**************************************************************************
	protected configurationDoneRequest(	response: DebugProtocol.ConfigurationDoneResponse,
										args: DebugProtocol.ConfigurationDoneArguments): void
	{
		this._runCallback();
	}


	//**************************************************************************
	protected launchRequest(response: DebugProtocol.LaunchResponse,
							args: LaunchRequestArguments): void
	{
		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		// start the program in the runtime
		this._runCallback = () => {
			this._runtime.start(args.program, !!args.stopOnEntry);
			this.sendResponse(response);
		};
	}


	//**************************************************************************
	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse,
									args: DebugProtocol.SetBreakpointsArguments): void
	{
		const vscBreakpoints = args.breakpoints;
		if(vscBreakpoints !== undefined && args.source.path !== undefined) {
			const path = <string>args.source.path;

			Breakpoints.clearAllBreakpointsIn(path, this._runtime, () => {
				Breakpoints.set(vscBreakpoints, path, this._runtime,
					(breakpoints: Array<Breakpoint>) => {
						response.body = {
							breakpoints: breakpoints
						};
						this.sendResponse(response);
					}
				);
			});
		} else {
			this.sendResponse(response);
		}
	}


	//**************************************************************************
	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		response.body = {
			threads: [
				new Thread(	OctaveDebugSession.THREAD_ID,
							"thread " + OctaveDebugSession.THREAD_ID)
			]
		};
		this.sendResponse(response);
	}


	//**************************************************************************
	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse,
								args: DebugProtocol.StackTraceArguments): void
	{
		const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
		const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
		const endFrame = startFrame + maxLevels;

		// Each time the program reaches any new instruction it requests the stack.
		// Since it'll recreate the scopes and variables, we clear them here.
		this.clear();

		const callback = (stackFrames: Array<StackFrame>) => {
			response.body = {
				stackFrames: stackFrames,
				totalFrames: stackFrames.length
			};

			this.sendResponse(response);
		};

		this._stackManager.get(startFrame, endFrame, this._runtime, callback);
	}


	//**************************************************************************
	protected scopesRequest(response: DebugProtocol.ScopesResponse,
							args: DebugProtocol.ScopesArguments): void
	{
		const callback = () => {
			// All stack frames have local and global scopes.
			const localScope = new OctaveScope(''); // local scope has no name.
			const globalScope = new OctaveScope('global');
			// Add references to the scopes so the UI can retrive them.
			Variables.addReferenceTo(localScope);
			Variables.addReferenceTo(globalScope);
			// Tell the UI which scopes are available.
			response.body = { scopes: [
				new Scope('local', localScope.reference(), false),
				new Scope(globalScope.name(), globalScope.reference(), false)
			]};

			this.sendResponse(response);
		};

		this._stackManager.selectStackFrame(args.frameId, this._runtime, callback);
	}


	//**************************************************************************
	protected variablesRequest(	response: DebugProtocol.VariablesResponse,
								args: DebugProtocol.VariablesArguments): void
	{
		const callback = (variables: Array<OctaveVariable>) => {
			response.body = {
				variables: variables.map(v => <Variable>{
					name: v.name(),
					type: v.typename(),
					value: v.value(),
					variablesReference: v.reference(),
					namedVariables: v.namedVariables(),
					indexedVariables: v.indexedVariables()
				})
			};
			this.sendResponse(response);
		};

		Variables.listByReference(args.variablesReference, this._runtime, callback);
	}


	//**************************************************************************
	protected setVariableRequest(	response: DebugProtocol.SetVariableResponse,
									variable: DebugProtocol.SetVariableArguments): void
	{
		Variables.setVariable(	variable.name,
								variable.value,
								this._runtime,
			(newValue: string) => {
				response.body = { value: newValue };
				this.sendResponse(response);
			});
	}


	//**************************************************************************
	protected evaluateRequest(	response: DebugProtocol.EvaluateResponse,
								args: DebugProtocol.EvaluateArguments): void
	{
		this._runtime.evaluate(args.expression, (result: string) => {
			response.body = {
				result: result,
				variablesReference: 0
			};
			this.sendResponse(response);
		});
	}


	//**************************************************************************
	protected continueRequest(	response: DebugProtocol.ContinueResponse,
								args: DebugProtocol.ContinueArguments): void
	{
		this._runtime.send('dbcont');
		this._runtime.sync();
		this.sendResponse(response);
	}


	//**************************************************************************
	protected nextRequest(	response: DebugProtocol.NextResponse,
							args: DebugProtocol.NextArguments): void
	{
		this._runtime.send('dbstep');
		this._runtime.sync();
		this.sendResponse(response);
	}


	//**************************************************************************
	protected stepInRequest(response: DebugProtocol.StepInResponse,
							args: DebugProtocol.StepInArguments): void
	{
		this._runtime.send('dbstep in');
		this._runtime.sync();
		this.sendResponse(response);
	}


	//**************************************************************************
	protected stepOutRequest(	response: DebugProtocol.StepOutResponse,
								args: DebugProtocol.StepOutArguments): void
	{
		this._runtime.send('dbstep out');
		this._runtime.sync();
		this.sendResponse(response);
	}


	//**************************************************************************
	private clear(): void {
		Variables.clearReferences();
		this._stackManager.clear();
	}
}

DebugSession.run(OctaveDebugSession);
