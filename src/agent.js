/**
 * Retail Email Agent
 *
 * An AI-powered agent that analyzes customer emails, looks up product information,
 * and generates helpful replies before forwarding emails to their destination.
 *
 * Uses Vercel AI SDK's generateText with Zod-schema tools for proper agentic tool use.
 */

import { Agent } from "agents";
import { generateText, stepCountIs, Output } from "ai";
import { productTools } from "./tools.js";
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
const model = openai("gpt-4o-2024-11-20");


export class RetailEmailAgent extends Agent {
	/**
	 * Cleanup stale MCP server connections
	 * Removes failed connections and optionally filters by URL pattern and name
	 * @param {Object} options - Cleanup options
	 * @param {string} options.keepUrlEndsWith - Keep servers with URLs ending in this string (e.g., "/sse")
	 * @param {string} options.keepName - Keep servers with this name
	 */
	async cleanupMcpServers({ keepUrlEndsWith = "/sse", keepName = "Google Calendar" } = {}) {
		const mcpState = this.getMcpServers();
		const entries = Object.entries(mcpState.servers || {});

		// Decide which ones to remove
		const toRemove = entries.filter(([id, s]) => {
			// remove anything failed
			if (s.state !== "ready") return true;

			// optionally remove non-SSE servers
			if (keepUrlEndsWith && !s.server_url?.endsWith(keepUrlEndsWith)) return true;

			// optionally remove other names
			if (keepName && s.name !== keepName) return false; // keep other names unless you want global cleanup

			return false;
		});

		if (toRemove.length === 0) return;

		console.log("Removing MCP servers:", toRemove.map(([id, s]) => ({ id, url: s.server_url, state: s.state })));

		// Remove sequentially (avoid bursts inside DO)
		for (const [id] of toRemove) {
			try {
				await this.removeMcpServer(id);
			} catch (e) {
				console.warn("removeMcpServer failed for", id, e?.message || e);
			}
		}
	}

	/**
	 * Helper function to connect to Google Calendar MCP server
	 * @param {Request} request - Request object for deriving callbackHost
	 */
	async connectToMcpServer(request) {
		if (!this.env?.MCP_SERVER_URL) {
			console.warn("MCP_SERVER_URL not configured");
			return null;
		}

		// Cleanup stale connections before checking for existing ones
		await this.cleanupMcpServers({ keepUrlEndsWith: "/sse", keepName: "Google Calendar" });

		// If already connected, reuse it - check for existing READY /sse server
		const mcpState = this.getMcpServers();
		const servers = Object.values(mcpState.servers || {});
		const readySse = servers.find(s =>
			s.name === "Google Calendar" &&
			s.state === "ready" &&
			s.server_url.endsWith("/sse")
		);
		if (readySse) return readySse;

		// callbackHost must be the Agent's origin (used for OAuth callbacks if ever needed)
		const callbackHost = request ? new URL(request.url).origin : undefined;

		// SSE endpoint for your MCP server
		const origin = new URL(this.env.MCP_SERVER_URL).origin; // ensures scheme/host only
		const serverUrl = new URL("/sse", origin).toString();   // <-- SSE endpoint

		try {
			console.log("Connecting to MCP (SSE)", { serverUrl, callbackHost });

			const result = await this.addMcpServer(
				"Google Calendar",
				serverUrl,
				callbackHost,
				undefined, // agentsPrefix
				{
					transport: { type: "sse" }, // <-- force SSE
				}
			);

			if (result.state === "authenticating") {
				console.warn("Unexpected: MCP server asked for auth:", result.authUrl);
				return null;
			}

			console.log("Connected to Google Calendar MCP server:", result.id);
			return result;
		} catch (error) {
			if (error?.message?.includes(".name") || error?.message?.includes("setName")) {
				console.warn("workerd issue #2240 hit; retry on next request:", error.message);
				return null;
			}
			console.error("Failed to connect to MCP server (SSE):", error);
			return null;
		}
	}


	/**
	 * Handle HTTP requests to the agent
	 */
	async fetch(request) {
		const url = new URL(request.url);

		// Handle analyze request
		if (url.pathname === "/internal/analyze" && request.method === "POST") {
			const body = await request.json();
			const analysis = await this.analyzeAndReply(
				body.emailContent,
				body.customerEmail,
				body.subject,
				request, // Pass request for MCP connection context
			);
			return new Response(JSON.stringify(analysis), {
				headers: { "Content-Type": "application/json" },
			});
		}

		return new Response("Not Found", { status: 404 });
	}


	/**
	 * Analyze customer email and generate a reply using Vercel AI SDK's generateText
	 * Returns: { canReply: boolean, replyContent: string, reason: string }
	 *
	 * Uses generateText with Zod-schema tools - the LLM can directly call tools
	 * to get product information and generate a reply.
	 * @param {Request} request - Request object for MCP connection context
	 */
	async analyzeAndReply(emailContent, customerEmail, subject, request) {
		try {
			// Access AI binding through env (Durable Objects have env available)
			if (!this.env || !this.env.AI) {
				throw new Error("AI binding not available. Make sure 'ai' binding is configured in wrangler.jsonc");
			}

			// Get calendar tools from MCP server if configured
			let calendarTools = {};
			if (this.env?.MCP_SERVER_URL) {
				try {
					// Connect to MCP server if not already connected (pass request for context)
					await this.connectToMcpServer(request);

					// Check MCP server state - find the READY SSE server specifically
					const mcpState = this.getMcpServers();
					const entries = Object.entries(mcpState.servers || {});

					// Pick the READY server that is the SSE endpoint
					const ready = entries.find(([id, s]) =>
						s.name === "Google Calendar" &&
						s.state === "ready" &&
						s.server_url.endsWith("/sse")
					);

					const serverId = ready?.[0];
					const calendarServer = ready?.[1];

					if (serverId && calendarServer && this.mcp) {
						// Server is ready, try to get tools
						try {
							// Ensure discovery has completed
							const discoverResult = await this.mcp.discoverIfConnected(serverId, { timeoutMs: 15000 });
							if (discoverResult?.success) {
								// Now get tools - JSON schema validator should be initialized
								const mcpTools = this.mcp.getAITools();
								if (mcpTools && Object.keys(mcpTools).length > 0) {
									calendarTools = mcpTools;
									console.log("Using MCP calendar tools:", Object.keys(calendarTools));
								} else {
									console.warn("MCP server ready but no tools returned from getAITools()");
								}
							} else {
								console.warn("Discovery not yet complete, tools not available");
							}
						} catch (getToolsError) {
							// If JSON schema validator isn't initialized yet, log and continue without tools
							if (getToolsError.message?.includes("jsonSchema")) {
								console.warn("MCP tools not yet initialized (JSON schema validator not ready), will retry on next request");
							} else {
								console.error("Error getting MCP tools:", getToolsError);
							}
						}
					} else {
						console.warn("Google Calendar MCP server (SSE) not found in ready state");
					}
				} catch (error) {
					console.error("Error getting MCP tools:", error);
				}
			}

			// Combine all available tools
			const allTools = {
				...productTools,
				...calendarTools,
			};

			console.log("Calendar tools:", this.env.MCP_SERVER_URL);
			// Create the system prompt for the agent
			const systemPrompt = `You are a customer service AI agent for a retail business.

Your task is to analyze incoming customer emails and decide whether you can fully and correctly answer or schedule a consultation for the customer using the available tools.

Available tools:
Product Catalog:
- getProductInfo: detailed info for a specific product
- searchProducts: search products by keyword
- getPricing: pricing for a specific product
- getAllProducts: list all products

Calendar/Scheduling${Object.keys(calendarTools).length > 0 ? ':' : ' (not available)'}
${Object.keys(calendarTools).length > 0 ? `- getAvailability: check available time slots for scheduling consultations
- createConsultation: create a new consultation/meeting in the calendar
- rescheduleConsultation: reschedule an existing consultation
- cancelConsultation: cancel a scheduled consultation` : ''}

Rules:
1. You may answer questions that can be resolved using:
   - Product catalog data (products, pricing, availability, categories, comparisons)
   ${Object.keys(calendarTools).length > 0 ? '- Calendar/scheduling tools (checking availability, creating/rescheduling/canceling consultations)' : ''}
2. If the email asks about anything outside these capabilities — including but not limited to:
   - order status
   - shipping
   - returns or refunds
   - complaints
   - account issues
   - support issues (unless they involve scheduling)
   you MUST NOT answer and must indicate the email should be forwarded to a human.
3. If you need product information to answer, call the appropriate tools first.
${Object.keys(calendarTools).length > 0 ? '4. If the customer wants to schedule, reschedule, or cancel a consultation, use the calendar tools.\n5. When scheduling, first check availability using getAvailability, then create the consultation.' : '4.'} Be friendly, professional, and concise in replies.
${Object.keys(calendarTools).length > 0 ? '6' : '5'}. Do NOT guess or hallucinate information.
${Object.keys(calendarTools).length > 0 ? '7' : '6'}. Do NOT mention internal tools, policies, or that you are an AI.

OUTPUT FORMAT (MANDATORY):
You MUST respond with valid JSON and nothing else.

If you CAN answer using the product catalog:
{
  "canReply": true,
  "reply": "<a complete, customer-ready reply>"
}

If you CANNOT answer using the product catalog:
{
  "canReply": false,
  "reason": "<short reason such as 'order status', 'returns', 'complaint', 'account issue'>"
}

Do not include any additional text outside this JSON.

Customer Email Metadata:
- Customer Email: ${customerEmail}
- Subject: ${subject}

Email Content:
${emailContent}`;

			// Define the response schema using Zod
			const responseSchema = z.object({
				canReply: z.boolean().describe("Whether the agent can reply to this email using product catalog information"),
				reply: z.string().optional().describe("The complete customer-ready reply (required if canReply is true)"),
				reason: z.string().optional().describe("Reason why the email cannot be answered (required if canReply is false)"),
			});

			// Use generateText with tools and structured output
			const result = await generateText({
				model: model,
				system: systemPrompt,
				prompt: `Please analyze this customer email and provide a helpful response. Use the available tools to look up any product information or manage calendar appointments as needed. If you can answer the customer's question, write a friendly reply. If you cannot (e.g., order status, returns, complaints), explain that the email will be forwarded to a human agent.`,
				tools: allTools,
				experimental_output: Output.object({
					schema: responseSchema,
				}),
				stopWhen: stepCountIs(5), // allow up to 5 steps total (tool calls + final)
				temperature: 0.0,
			});

			console.log("Result:", JSON.stringify(result.resolvedOutput, null, 2));

			// Extract the structured output from the result
			const parsedResponse = result.resolvedOutput;

			// Validate the parsed response structure
			if (typeof parsedResponse?.canReply !== "boolean") {
				return {
					canReply: false,
					replyContent: null,
					reason: "Invalid response format: missing or invalid 'canReply' field",
				};
			}

			// Return based on the parsed JSON response
			if (parsedResponse.canReply) {
				if (!parsedResponse.reply || typeof parsedResponse.reply !== "string") {
					return {
						canReply: false,
						replyContent: null,
						reason: "Invalid response format: missing or invalid 'reply' field",
					};
				}
				return {
					canReply: true,
					replyContent: parsedResponse.reply.trim(),
					reason: "Agent generated a helpful reply using product information",
				};
			} else {
				return {
					canReply: false,
					replyContent: null,
					reason: parsedResponse.reason || "Email requires human attention",
				};
			}
		} catch (error) {
			console.error("Error in AI analysis:", error);
			return {
				canReply: false,
				replyContent: null,
				reason: `Error during analysis: ${error.message}`,
			};
		}
	}
}

