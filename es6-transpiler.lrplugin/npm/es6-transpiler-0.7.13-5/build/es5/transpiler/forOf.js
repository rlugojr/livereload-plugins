"use strict";

var assert = require("assert");
var error = require("./../lib/error");
var core = require("./core");
var destructuring = require("./destructuring");



function isObjectPattern(node) {
	return node && node.type == 'ObjectPattern';
}

function isArrayPattern(node) {
	return node && node.type == 'ArrayPattern';
}

var getIteratorBody =
	"(v){" +
		"if(v){" +
			"if(Array.isArray(v))return 0;" +
			"if(typeof v==='object'&&typeof v['@@iterator']==='function')return v['@@iterator']();" +
		"}" +
		"throw new Error(v+' is not iterable')"+
	"};"
;

var plugin = module.exports = {
	reset: function() {

	}

	, setup: function(alter, ast, options) {
		if( !this.__isInit ) {
			this.reset();
			this.__isInit = true;
		}

		this.alter = alter;
		this.options = options;
	}

	, ':: ForOfStatement': function replaceForOf(node) {
		var hasBlock = (node.body.type === "BlockStatement");

		var nodeStartsFrom = node.body.range[0];

		var insertHeadPosition = (hasBlock
			? nodeStartsFrom + 1// just after body {
			: nodeStartsFrom)	// just before existing expression
		;

		var replacementObj = this.createForOfReplacement(node, node.body, true);

		this.alter.insert(//before for of
			node.range[0]
			, replacementObj.before
			, {extend: true, applyChanges: true}
		);
		this.alter.insertBefore(//after for of body begin, but before any other insert (loop closure function start, for example)
			insertHeadPosition
			, (hasBlock ? "" : "{") + replacementObj.inner
		);
		this.alter.insertAfter(//after for of
			node.range[1]
			, (hasBlock ? "" : "}") + replacementObj.after
			, {extend: true}
		);
		this.alter.setState("replaceForOf");
		if( replacementObj.remove ) {
			// remove 'var {des, truc, turing}' from for(var {des, truc, turing} of something){  }
			this.alter.remove(
				replacementObj.remove[0]
				, replacementObj.remove[1]
			);
		}

		var from = node.left.range[1] + 1
			, to = insertHeadPosition - (hasBlock ? 1 : 0)//just before {
		;
		var lineBreaks = !hasBlock && this.alter.getRange(from, to).match(/[\r\n]/g) || [];

		this.alter.replace(//instead for of declaration body: for(var a of b) -> for(var a <forOfString>)
			from
			, to
			, replacementObj.loop + ")" + lineBreaks.join("")
		);
		this.alter.restoreState();
	}

	, createForOfReplacement: function(node, bodyNode, needTemporaryVariableCleaning) {
		var scopeOptions = core.getScopeOptions(node.$scope, node);
		var needIteratorSupport = scopeOptions['has-iterators'] !== false || scopeOptions['has-generators'] !== false;

		var getIteratorFunctionName = needIteratorSupport ? core.bubbledVariableDeclaration(node.$scope, "GET_ITER", getIteratorBody, true) : "";

		var variableBlock = node.left;
		var isDeclaration = variableBlock.type === "VariableDeclaration";

		var declarations = isDeclaration ? variableBlock.declarations : null
			, declaration = isDeclaration ? declarations[0] : null
		;

		if( isDeclaration ) {
			assert(declarations.length === 1);
		}

		var variableId = isDeclaration ? declaration.id : variableBlock
			, variableIdIsDestructuring = isObjectPattern(variableId) || isArrayPattern(variableId)
			, variableInit = node.right
			, variableInitIsIdentifier = variableInit.type === "Identifier"

			, tempVars = [
				core.getScopeTempVar(bodyNode, node.$scope)// index or iterator
				, core.getScopeTempVar(bodyNode, node.$scope)	// length or current value
			]
		;

		assert(
			isDeclaration
			|| variableBlock.type === "Identifier"
			|| variableIdIsDestructuring
			, variableBlock.type + " is a wrong type for forOf left part");

		if ( needIteratorSupport ) {
			tempVars.push(
				core.getScopeTempVar(bodyNode, node.$scope)// isArray
			)
		}

		if( !variableInitIsIdentifier ) {
			tempVars.push(
				core.getScopeTempVar(bodyNode, node.$scope)// empty string or variable name
			);
		}

		var variableInitString;
		var beforeBeginString = "";//Init string


		if( variableInitIsIdentifier ) {
			variableInitString = variableInit.name;
		}
		else {
			beforeBeginString += (tempVars[3] + " = (" + this.alter.get(variableInit.range[0], variableInit.range[1]) + ");");
			variableInitString = tempVars[3];
		}

		var innerString
			, forOfString
			, initString
			, afterString = ";" + (needTemporaryVariableCleaning ? (tempVars.join(" = ") + " = void 0;") : "")//cleanup string
		;

		if ( needIteratorSupport ) {
			beforeBeginString +=
				tempVars[0]
					+ " = " + getIteratorFunctionName + "(" + variableInitString + ");"
					+ tempVars[2] + " = " + tempVars[0] + " === 0;"
					+ tempVars[1] + " = (" + tempVars[2] + " ? " + variableInitString + ".length : void 0);"
			;

			forOfString =
				"; " + tempVars[2] + " ? (" + tempVars[0] + " < " + tempVars[1] + ") : !(" + tempVars[1] + " = " + tempVars[0] + "[\"next\"]())[\"done\"]; ";

			initString =
				"(" + tempVars[2] + " ? " + variableInitString + "[" + tempVars[0] + "++] : " + tempVars[1] + "[\"value\"])";
		}
		else {
			beforeBeginString +=
				tempVars[0] + " = 0;"
				+ tempVars[1] + " = " + variableInitString + ".length;"
			;

			forOfString =
				"; " + tempVars[0] + " < " + tempVars[1] + "; ";

			initString =
				"(" + variableInitString + "[" + tempVars[0] + "++])";
		}

		if( variableIdIsDestructuring ) {
			variableInit["$raw"] = initString;
			var newDefinitions = [];
			innerString = ";" + (
				destructuring.unwrapDestructuring("var", variableId, variableInit, null, newDefinitions) + ";"
			).substr(4);//remove "var "

			assert(newDefinitions.length);

			beforeBeginString = "var " + newDefinitions.map(function(a){ return a.id.name }).join(", ") + ";" + beforeBeginString;

			delete variableInit["$raw"];
		}
		else {
			innerString = variableId.name + " = " + initString + ";";
		}

		while(tempVars.length) {
			core.setScopeTempVar(tempVars.shift(), bodyNode, node.$scope);
		}

		return {
			before: beforeBeginString
			, loop: forOfString
			, inner: innerString
			, after: afterString
			, remove: variableIdIsDestructuring ? variableBlock.range : void 0
		}
	}
};

for(var i in plugin) if( plugin.hasOwnProperty(i) && typeof plugin[i] === "function" ) {
	plugin[i] = plugin[i].bind(plugin);
}
