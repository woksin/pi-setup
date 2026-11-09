import assert from "node:assert/strict";
import { test } from "node:test";
import publishExtension from "../extensions/publish.ts";
import issueWorkExtension from "../extensions/issue-work.ts";

function registeredTool(extension: (pi: any) => void): any {
	let tool: any;
	extension({ registerTool: (definition: unknown) => { tool = definition; }, on: () => {}, registerCommand: () => {} });
	assert.ok(tool);
	return tool;
}
function sizes(tool: any) {
	const description = Buffer.byteLength(tool.description);
	const schema = Buffer.byteLength(JSON.stringify(tool.parameters));
	return { description, schema, total: description + schema };
}
test("publish fixed-prompt schema and description stay within the byte budget", () => {
	const size = sizes(registeredTool(publishExtension));
	assert.ok(size.total <= 5000, `publish total: ${size.total} > 5000 B`);
	assert.ok(size.schema <= 4000, `publish schema: ${size.schema} > 4000 B`);
	assert.ok(size.description <= 1000, `publish description: ${size.description} > 1000 B`);
});
test("issue_work fixed-prompt schema and descriptions stay within the byte budget", () => {
	const tool = registeredTool(issueWorkExtension), size = sizes(tool);
	const parameters = Object.values(tool.parameters.properties) as { description?: string }[];
	const parameterBytes = parameters.reduce((sum, property) => sum + Buffer.byteLength(property.description ?? ""), 0);
	assert.ok(size.total <= 2500, `issue_work total: ${size.total} > 2500 B`);
	assert.ok(size.description <= 1200, `issue_work description: ${size.description} > 1200 B`);
	assert.ok(parameterBytes <= 1300, `issue_work parameter descriptions: ${parameterBytes} > 1300 B`);
	for (const key of ["takeover", "acceptOutsider", "force", "plan", "days", "free"]) {
		assert.ok(Buffer.byteLength(tool.parameters.properties[key].description) <= 80, `${key} description exceeds 80 B`);
	}
});
