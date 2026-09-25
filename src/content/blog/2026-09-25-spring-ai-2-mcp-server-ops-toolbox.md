---
author: StevenPG
pubDatetime: 2026-09-25T13:00:00.000Z
title: "Give Your Spring Boot Service an MCP Ops Interface with Spring AI 2.0"
slug: spring-ai-2-mcp-server-ops-toolbox
featured: false
draft: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - ai
  - mcp
  - observability
description: Build a Model Context Protocol server into a Spring Boot 4.1 service with Spring AI 2.0's @McpTool annotations, so Claude Code or any MCP client can read its health, metrics, traffic and logs, and safely turn up a log level, with guard rails and end-to-end tests.
---

## Table of Contents

[[toc]]

# The pitch

At some point during every incident, somebody pastes a stack trace into a chat window and asks an AI what's
wrong. The model then works from whatever you remembered to copy: one exception, no metrics, no idea which
endpoint is failing or how often.

The [Model Context Protocol](https://modelcontextprotocol.io/) fixes the copy-and-paste step. An MCP server
exposes *tools* the model can call itself. Spring AI 2.0 (GA in June, 2.0.1 current) made writing one about as
hard as writing a `@RestController`. So instead of a toy calculator server, this post builds something I'd
actually attach to a service. The service exposes its own health, metrics, traffic, logs and thread state as MCP
tools, so Claude Code (or any MCP client) can triage the running instance directly.

The whole project, with tests, is in
[DemosAndArticleContent/blog/spring-ai-mcp-ops-toolbox](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/spring-ai-mcp-ops-toolbox).
Every JSON response in this post is real output from that project.

# What changed in Spring AI 2.0 for MCP

If you tried MCP servers on Spring AI 1.x, three things are different:

- **Annotations are in core.** `@McpTool`, `@McpToolParam`, `@McpResource`, `@McpPrompt` and `@McpArg` live
  in `org.springframework.ai.mcp.annotation` and are picked up by the server starter's annotation scanner.
  You no longer need a `ToolCallbackProvider` bean for every tool class.
- **The Spring transports moved into Spring AI.** `mcp-spring-webmvc` and `mcp-spring-webflux` are now
  published under `org.springframework.ai`, not the MCP SDK's group. The underlying Java SDK is at 2.0.
- **SSE is deprecated. Use Streamable HTTP, or stateless.** `spring.ai.mcp.server.protocol` takes `STREAMABLE`
  or `STATELESS`. The old `SSE` value still works but is marked deprecated.

The dependencies, with Spring Boot 4.1:

```groovy
dependencyManagement {
    imports { mavenBom 'org.springframework.ai:spring-ai-bom:2.0.1' }
}

dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-webmvc'
    implementation 'org.springframework.boot:spring-boot-starter-actuator'
    implementation 'org.springframework.ai:spring-ai-starter-mcp-server-webmvc'
}
```

And the configuration:

```properties
spring.ai.mcp.server.name=ops-toolbox
spring.ai.mcp.server.version=1.0.0
spring.ai.mcp.server.protocol=STATELESS
spring.ai.mcp.server.type=SYNC
spring.ai.mcp.server.instructions=Operational tools for one running Spring Boot instance: \
  health, metrics, HTTP traffic, recent logs, JVM and thread state. \
  Start with get_health, then http_traffic_summary, then recent_logs.
```

`instructions` is sent to the client at initialization, and most clients put it in the model's context. It's
the cheapest way to tell the model how to use your tools.

## Stateless or Streamable?

With `STREAMABLE`, the server keeps a session per client. That lets it push messages to the client: progress
notifications, *sampling* (asking the client's model to generate something) and *elicitation* (asking the user a
question). With `STATELESS`, every JSON-RPC request stands alone.

For an ops interface I want stateless. Any replica behind a plain load balancer can answer, with no sticky
sessions, and none of these tools needs to call back into the client. A nice side effect: you can call a tool
with `curl` and no handshake at all.

```bash
curl -s localhost:8080/mcp -H "Authorization: Bearer dev-key" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"http_traffic_summary","arguments":{}}}'
```

One caveat on "any replica can answer": these tools describe *the instance that answers*. Behind a load
balancer, each call may hit a different pod. For a whole fleet you'd want the tools to query Prometheus and Loki
instead. For one pod you port-forward to, or a local dev instance, in-process is exactly right.

# The tools

Nine tools, one resource and one prompt:

| Tool | Backed by | Read-only |
|---|---|---|
| `get_health` | the actuator's `HealthEndpoint` bean | yes |
| `list_metrics` / `get_metric` | Micrometer `MeterRegistry` | yes |
| `http_traffic_summary` | the `http.server.requests` timers, aggregated per endpoint | yes |
| `recent_logs` | a Logback ring-buffer appender | yes |
| `get_log_level` | Boot's `LoggingSystem` | yes |
| `set_log_level_temporarily` | Boot's `LoggingSystem`, with a TTL | **no** |
| `jvm_summary` / `thread_summary` | the platform MXBeans | yes |

## A tool is an annotated method

```java
@Component
public class HealthTools {

    private final HealthEndpoint healthEndpoint;

    public HealthTools(HealthEndpoint healthEndpoint) {
        this.healthEndpoint = healthEndpoint;
    }

    @McpTool(name = "get_health", title = "Application health",
            description = "Overall application health and the status of every health component "
                    + "(disk space, database, downstream services...). Start here when something is wrong.",
            annotations = @McpAnnotations(readOnlyHint = true, idempotentHint = true, openWorldHint = false))
    public HealthDescriptor health() {
        return healthEndpoint.health();
    }
}
```

Three details are doing real work here:

1. **Call the actuator beans, not the actuator's HTTP endpoints.** `HealthEndpoint` is the same bean behind
   `/actuator/health`. Injecting it means every `HealthIndicator` you've already written shows up in the tool,
   and you don't have to expose the actuator over HTTP for the tool to work. (Health moved to
   `org.springframework.boot.health.actuate.endpoint` in Boot 4. If you're coming from my
   [Actuator guide](/posts/ultimate-guide-spring-boot-actuator), that's the one import that changed.)
2. **The description is a prompt.** "Start here when something is wrong" is instruction for the model, not
   documentation for you.
3. **The annotations are for the client.** `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`
   travel with the tool definition, and clients can use them to decide what to auto-approve and when to ask
   first. They're hints, not enforcement. The server still has to protect itself, which the write tool below does.

## Shape the response for a context window

The actuator's `/metrics/http.server.requests` answer is built for dashboards: every tag combination and
every statistic. A model pays for every token of it. So `http_traffic_summary` aggregates the timers into one
row per endpoint, busiest first, and leaves out `/actuator` and `/mcp` by default:

```java
@McpTool(name = "http_traffic_summary", title = "HTTP traffic by endpoint",
        description = "Per-endpoint request counts, 4xx/5xx counts, mean and max latency since startup, "
                + "busiest first. The fastest way to find which endpoint is failing or slow.",
        annotations = @McpAnnotations(readOnlyHint = true, idempotentHint = true, openWorldHint = false))
public List<EndpointTraffic> httpTrafficSummary(
        @McpToolParam(description = "Include /actuator and /mcp endpoints (default false)", required = false) Boolean includeInternal,
        @McpToolParam(description = "Max rows (default 20)", required = false) Integer limit) {
    // group registry.find("http.server.requests").timers() by (method, uri),
    // sum counts per status class, keep mean and max
}
```

After 300 requests against the demo's deliberately flaky endpoint:

```json
[
  {
    "method": "GET",
    "uri": "/api/orders/{id}",
    "requests": 300,
    "serverErrors": 18,
    "clientErrors": 7,
    "meanMs": 33.2,
    "maxMs": 1097.5
  }
]
```

Returning a record or `List` of records is all it takes. Spring AI serializes it to JSON text content, and
`@McpToolParam(required = false)` becomes an optional property in the generated input schema.

## Logs: a ring buffer, not a log pipeline

The most useful thing during triage is "what did it log just now?" So `recent_logs` reads from a Logback
appender that keeps the last 2,000 events in memory. It attaches itself to the root logger at startup, with no
`logback-spring.xml` needed:

```java
@Component
public class LogRingBuffer extends AppenderBase<ILoggingEvent> {

    @PostConstruct
    void attach() {
        var context = (LoggerContext) LoggerFactory.getILoggerFactory();
        setContext(context);
        start();
        context.getLogger(Logger.ROOT_LOGGER_NAME).addAppender(this);
    }

    @Override
    protected void append(ILoggingEvent event) {
        // flatten to LogLine(timestamp, level, logger, thread, message, error) and add to a bounded deque
    }
}
```

Errors keep the exception chain but only the first four frames of each cause, and they skip
`jdk.internal.reflect` / `java.lang.reflect` frames. Those were half of every trace in the first version, and they
tell the model nothing:

```json
{
  "level": "ERROR",
  "logger": "com.stevenpg.opsmcp.demo.OrderController",
  "message": "Order 138 lookup failed: inventory-service did not respond",
  "error": "java.lang.IllegalStateException: inventory-service unavailable\n    at com.stevenpg.opsmcp.demo.OrderController.order(OrderController.java:46)\n    ...\nCaused by: java.net.SocketTimeoutException: Read timed out after 2000ms\n    at com.stevenpg.opsmcp.demo.OrderController.order(OrderController.java:45)\n    ..."
}
```

This is a debugging aid, not a log store. It covers minutes of history for one instance and is gone on
restart. Your real logs still go to stdout.

# The one tool that writes

Reading is safe. Changing things is where an ops interface for an AI needs design. I allowed exactly one write,
because it's the one I reach for most often during an incident: turning up a log level.

```java
@McpTool(name = "set_log_level_temporarily", title = "Temporarily change a log level",
        description = "Temporarily change a logger's level. It reverts automatically after ttlMinutes "
                + "(default 15, max 60). Only loggers under the server's allow-listed prefixes can be changed.",
        annotations = @McpAnnotations(readOnlyHint = false, destructiveHint = false, idempotentHint = true, openWorldHint = false))
public LevelChange setLogLevel(String logger, String level, Integer ttlMinutes) {
    if (writablePrefixes.stream().noneMatch(logger::startsWith)) {
        throw new IllegalArgumentException("Logger '" + logger + "' is not under an allow-listed prefix " + writablePrefixes);
    }
    // remember the ORIGINAL level (even across repeated calls), set the new one,
    // schedule a revert, log a WARN so humans can see the agent did it
}
```

The guard rails:

- **An allow-list, not a deny-list.** `ops.mcp.writable-logger-prefixes=com.stevenpg,org.springframework.web`.
  `ROOT` isn't on it, because TRACE on ROOT is how you fill a disk.
- **Every change expires.** The default is 15 minutes, with a hard cap of 60. Calling it again extends the TTL
  but keeps the *original* level as the revert target. On shutdown, pending changes revert immediately. An agent
  can't leave DEBUG on over a weekend.
- **Every change is logged at WARN**, so the humans reading the logs know an agent did it.
- **Throw, don't return an error string.** A thrown exception becomes a tool result with `isError: true`, which
  clients show differently and models treat as a failure:

```json
{"content":[{"type":"text","text":"Logger 'ROOT' is not under an allow-listed prefix [com.stevenpg, org.springframework.web]\n..."}],"isError":true}
```

What I deliberately *didn't* build: an environment or configuration dump. It's the obvious next tool,
and it's the one most likely to put a database password into a chat transcript that gets stored somewhere you
don't control.

# Resources and prompts

Tools are what the *model* decides to call. MCP has two other primitives, and Spring AI 2.0 annotates both.

A **resource** is context the *client* can attach without the model asking. Here, it's which instance you're
looking at:

```java
@McpResource(uri = "ops://app/info", name = "app-info", mimeType = "application/json",
        description = "Which application and instance this MCP server is attached to: name, profiles, JVM, start time, PID.")
public String appInfo() { ... }
```

A **prompt** is a template the *user* invokes, and most clients show it as a slash command. I used it to encode the
triage order an on-call engineer would follow, so the model doesn't open with thread dumps while the database is down:

```java
@McpPrompt(name = "triage", title = "Triage this service",
        description = "Walk the ops tools in a sensible order to explain a reported symptom.")
public String triage(@McpArg(name = "symptom", required = true) String symptom) {
    return """
            A user reports: "%s"
            Investigate this service using the ops tools, in this order, and stop as soon as you have a
            well-supported explanation:
            1. get_health  2. http_traffic_summary  3. recent_logs with minLevel=WARN
            4. jvm_summary / thread_summary - only if the above point at resource exhaustion or hangs.
            ...
            """.formatted(symptom);
}
```

A plain `String` return is converted into a single user message.

# Security: the starters are wide open

This is straight from the Spring AI docs, and easy to miss: *the HTTP-based server transports expose an
unauthenticated JSON-RPC endpoint by default.* A tool that reads your logs is a data-exfiltration endpoint if
anybody can reach it.

The project ships the smallest thing that isn't nothing: a filter on `/mcp` only that requires
`Authorization: Bearer <key>`, compared in constant time with `MessageDigest.isEqual`. If `ops.mcp.api-key`
is blank, it generates a key and logs it once, the way Spring Security does with its default password. No key
means `401` with `WWW-Authenticate: Bearer`.

That's fine for a local or dev instance. For anything shared, put `/mcp` behind Spring Security as an OAuth2
resource server. The MCP authorization spec is built on OAuth 2.1, and clients that implement it run the browser
flow for you.

# Testing it like a client would

The project's integration test starts the app on a random port and uses the **official MCP Java SDK client** over
Streamable HTTP, which is the same path Claude Code takes:

```java
var transport = HttpClientStreamableHttpTransport.builder("http://localhost:" + port)
        .endpoint("/mcp")
        .httpRequestCustomizer((builder, method, uri, body, context) ->
                builder.header("Authorization", "Bearer " + key))
        .build();
McpSyncClient client = McpClient.sync(transport).requestTimeout(Duration.ofSeconds(10)).build();
client.initialize();

CallToolResult result = client.callTool(
        CallToolRequest.builder("recent_logs").arguments(Map.of("minLevel", "ERROR")).build());
```

The test sets the demo endpoint's failure rate to 100%, sends three requests, and asserts that
`http_traffic_summary` reports `"serverErrors":3` and that `recent_logs` contains the `SocketTimeoutException`.
That's the whole triage loop, checked end to end. Other tests check that the refusal on `ROOT` comes back as
`isError`, that exactly one tool isn't read-only, and that a client with the wrong key can't initialize.

One SDK note: in MCP Java SDK 2.0, the request records' old constructors *and* their no-arg `builder()` are
deprecated. Use `CallToolRequest.builder(name)`, `ReadResourceRequest.builder(uri)` and
`GetPromptRequest.builder(name)`.

# Connect Claude Code

```bash
OPS_MCP_API_KEY=dev-key ./gradlew bootRun
./scripts/traffic.sh 300

claude mcp add --transport http ops-toolbox http://localhost:8080/mcp \
  --header "Authorization: Bearer dev-key"
```

Then ask "the orders API is flaky, what's going on?", or run the `triage` prompt with that as the symptom.

> **[DRAFT NOTE]** Add a transcript of a real Claude Code session against the demo here: the tool calls it
> chose, in what order, and the answer it gave. The tools and tests are verified; the client session isn't
> captured yet.

# Where to take it next

- **Fleet scope:** swap the in-process implementations for Prometheus and Loki queries, and the same tool
  names describe every replica instead of one.
- **More guarded writes:** evict a cache, drain a node from a pool, trip a circuit breaker. Same pattern
  each time: allow-list, TTL or undo, WARN log, `destructiveHint` set honestly.
- **Real auth:** Spring Security resource server + the MCP authorization spec.

The broader point: for a Spring developer, an MCP server is now just another interface on a service you
already have, like a `@RestController` for a caller that reads descriptions instead of OpenAPI specs. Design
it with the same care: small responses, honest annotations, and guard rails on anything that writes.
