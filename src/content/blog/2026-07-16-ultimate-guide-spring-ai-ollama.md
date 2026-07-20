---
author: StevenPG
pubDatetime: 2026-07-16T12:00:00.000Z
title: Ultimate Guide to Spring AI with Local Models (Ollama)
slug: ultimate-guide-spring-ai-ollama
featured: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - ai
  - llm
description: A complete guide to Spring AI with locally-hosted Ollama models — chat, embeddings, and a full RAG chatbot that answers questions about this blog, with zero API keys and zero cloud calls.
---

# Ultimate Guide to Spring AI with Local Models (Ollama)

## Table of Contents

[[toc]]

## Brief

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. This one is the guide I wish existed when I started wiring **Spring AI** to **Ollama**: every tutorial either assumed an OpenAI key or stopped at "hello world" before the parts that actually matter — embeddings, vector stores, and RAG.

By the end of this post you'll have a Spring Boot service that answers questions about a corpus of markdown documents, running entirely on your machine. No API keys, no per-token billing, no data leaving your laptop. The demo repo ships with a tiny sample corpus — three markdown posts about cats — so you can see retrieval working end-to-end before you point it at anything of your own. The complete project is at [github.com/StevenPG/DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/spring-ai-ollama-rag).

If you've read [Running Claude Code Locally on Apple Silicon](/posts/running-claude-code-locally-on-apple-silicon), this is the same philosophy applied to application development: local models are now good enough that "just run it yourself" is a legitimate architecture, not a science project.

## Why Local Models for Spring Apps?

Three reasons this setup keeps coming up in real projects:

1. **Data privacy** — RAG means shipping your documents to the model. With Ollama, "shipping" means a localhost HTTP call. For internal tooling over confidential docs, this ends the compliance conversation before it starts.
2. **Cost profile** — a chatbot over internal documents might serve 50 queries a day. An always-free local model beats even cheap API pricing when there's no scale to amortize.
3. **Development loop** — hitting a local model in tests and dev means no rate limits, no flaky network, no secrets management in CI.

The tradeoff is capability: a local 8B model is not a frontier model. For RAG over a bounded corpus — where the model mostly needs to read retrieved context and synthesize — that tradeoff is usually fine.

## Setup: Ollama

[Ollama](https://ollama.com) is a local model server with a Docker-like UX. Install it, then:

```bash
ollama serve   # usually already running as a service after install
```

That's the whole server. It listens on `localhost:11434`. We need two models — one for chat, one for embeddings:

```bash
ollama pull qwen3:8b           # chat model, ~5GB
ollama pull nomic-embed-text   # embedding model, ~270MB
```

You can skip the manual pulls entirely — Spring AI can pull missing models on startup, which we'll configure below. On Apple Silicon, `qwen3:8b` runs comfortably on a 16GB machine; if you have 32GB+, `qwen3:32b` is a meaningful quality jump. On the embedding side, `nomic-embed-text` is small, fast, and good enough that I've never needed to revisit the choice for a corpus this size.

## Setup: Spring AI

One important version note up front: **Spring AI 1.1.x targets Spring Boot 3.5.x**. If you're on Spring Boot 4 (see the [migration guide](/posts/ultimate-guide-spring-boot-4-migration)), keep this service on Boot 3.5 for now and migrate when Spring AI's Boot 4 line goes GA.

build.gradle.kts:

```kotlin
plugins {
    java
    id("org.springframework.boot") version "3.5.9"
    id("io.spring.dependency-management") version "1.1.7"
}

extra["springAiVersion"] = "1.1.2"

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-web")

    // Chat + embeddings against a local Ollama server
    implementation("org.springframework.ai:spring-ai-starter-model-ollama")
    // QuestionAnswerAdvisor — the RAG glue
    implementation("org.springframework.ai:spring-ai-advisors-vector-store")
}

dependencyManagement {
    imports {
        mavenBom("org.springframework.ai:spring-ai-bom:${property("springAiVersion")}")
    }
}
```

And the configuration:

```yaml
spring:
  ai:
    ollama:
      base-url: http://localhost:11434
      init:
        # Pull models automatically on startup if they aren't present
        pull-model-strategy: when_missing
      chat:
        options:
          model: qwen3:8b
          temperature: 0.2
      embedding:
        options:
          model: nomic-embed-text
```

The `pull-model-strategy: when_missing` line is a small thing that removes an entire class of "works on my machine" problems — a fresh checkout pulls its own models on first boot.

## The Core Abstraction: ChatClient

Spring AI's `ChatClient` is deliberately shaped like `WebClient`/`RestClient` — a fluent builder over a request/response cycle. The simplest possible use:

```java
@RestController
public class HelloAiController {

    private final ChatClient chatClient;

    public HelloAiController(ChatClient.Builder builder) {
        this.chatClient = builder.build();
    }

    @GetMapping("/hello-ai")
    String hello() {
        return chatClient.prompt()
                .user("Explain B-tree page splits in one paragraph.")
                .call()
                .content();
    }
}
```

Because the Ollama starter is on the classpath, the auto-configured `ChatClient.Builder` is already pointed at your local model. Swapping to OpenAI or Anthropic later means changing the starter dependency and properties — the controller code doesn't change. That portability is Spring AI's entire pitch, and it's real.

## Embeddings and the Vector Store

RAG needs a place to put document embeddings. For a blog-sized corpus, Spring AI's `SimpleVectorStore` — an in-memory store with optional JSON persistence — is genuinely all you need:

```java
@Configuration
public class RagConfiguration {

    @Bean
    VectorStore vectorStore(EmbeddingModel embeddingModel) {
        return SimpleVectorStore.builder(embeddingModel).build();
    }
}
```

The `EmbeddingModel` is auto-configured from the Ollama starter, backed by `nomic-embed-text`. When the corpus outgrows memory, the change is one dependency (`spring-ai-starter-vector-store-pgvector`) and a Postgres instance — the `VectorStore` interface stays identical. Given that I've [run Postgres in 150MB of memory](/posts/postgres-on-less-than-150mb-of-memory), the "heavyweight" option is lighter than people think.

## Ingestion: Turning Markdown Files into Chunks

The ingestion pipeline reads every markdown file in `corpus/`, splits it into token-sized chunks, embeds each chunk, and stores it. The demo's `corpus/` directory ships with three sample posts about cats — "Why Cats Knock Things Off Tables," "The Science of Cat Purring," and "Choosing a Cat Breed for Apartment Living" — small enough to ingest in a couple seconds so you can go straight to asking it questions:

```java
@Component
public class BlogIngestionService {

    private final VectorStore vectorStore;
    private final Path corpusDir;

    public BlogIngestionService(VectorStore vectorStore,
                                @Value("${blog.corpus-dir:./corpus}") Path corpusDir) {
        this.vectorStore = vectorStore;
        this.corpusDir = corpusDir;
    }

    @Bean
    ApplicationRunner ingest() {
        return args -> {
            TokenTextSplitter splitter = TokenTextSplitter.builder()
                    .withChunkSize(400)
                    .withMinChunkSizeChars(200)
                    .build();

            try (Stream<Path> files = Files.list(corpusDir)) {
                List<Document> chunks = files
                        .filter(p -> p.toString().endsWith(".md"))
                        .flatMap(p -> splitter.split(toDocument(p)).stream())
                        .toList();

                vectorStore.add(chunks);
            }
        };
    }

    private Document toDocument(Path path) {
        try {
            return new Document(Files.readString(path),
                    Map.of("source", path.getFileName().toString()));
        } catch (IOException e) {
            throw new IllegalStateException("Failed to read " + path, e);
        }
    }
}
```

Two decisions worth explaining:

**Chunk size 400 tokens.** Chunks need to be small enough that retrieval is precise (a chunk about UUID fragmentation shouldn't also contain a Docker tutorial) but large enough to carry a complete thought. 300–500 tokens is the boring, correct default for prose.

**Metadata on every chunk.** The `source` entry survives all the way to the prompt, which lets the model cite which post an answer came from. Cheap to add, very hard to retrofit.

For the demo's three cat posts, that's just 4 chunks and ingestion finishes before the log has scrolled past it:

```text
2026-07-20T03:48:20.099-04:00  INFO 27316 --- [spring-ai-ollama-rag] [           main] c.example.blograg.BlogIngestionService   : Embedding 4 chunks from corpus — first run downloads take a while
2026-07-20T03:48:20.858-04:00  INFO 27316 --- [spring-ai-ollama-rag] [           main] o.s.ai.vectorstore.SimpleVectorStore     : Calling EmbeddingModel for document id = 62ff0ffc-f32c-45d2-aa49-179ffe7b034d
2026-07-20T03:48:20.977-04:00  INFO 27316 --- [spring-ai-ollama-rag] [           main] o.s.ai.vectorstore.SimpleVectorStore     : Calling EmbeddingModel for document id = c62477a1-86e0-4533-a3d2-3999fbcd59d3
2026-07-20T03:48:21.018-04:00  INFO 27316 --- [spring-ai-ollama-rag] [           main] o.s.ai.vectorstore.SimpleVectorStore     : Calling EmbeddingModel for document id = 2784a9b5-8936-417f-a664-742c1910abba
2026-07-20T03:48:21.044-04:00  INFO 27316 --- [spring-ai-ollama-rag] [           main] o.s.ai.vectorstore.SimpleVectorStore     : Calling EmbeddingModel for document id = 641db504-fc85-4541-8ca4-7c205bbad24e
2026-07-20T03:48:21.121-04:00  INFO 27316 --- [spring-ai-ollama-rag] [           main] c.example.blograg.BlogIngestionService   : Ingestion complete
```

Swap in your own markdown — a blog, internal docs, meeting notes — and the same pipeline scales to however many files you drop in `corpus/`; ingestion time grows roughly linearly with chunk count.

## RAG: The QuestionAnswerAdvisor

Here's where Spring AI earns its keep. RAG — retrieve relevant chunks, stuff them into the prompt, instruct the model to answer from them — is conceptually simple and tedious to hand-roll. Spring AI packages the whole pattern as an _advisor_ on the ChatClient:

```java
@RestController
public class ChatController {

    private final ChatClient chatClient;

    public ChatController(ChatClient.Builder builder, VectorStore vectorStore) {
        this.chatClient = builder
                .defaultSystem("""
                        You answer questions about the documents in the corpus.
                        Only answer from the provided context. If the context
                        doesn't contain the answer, say you don't know rather
                        than guessing. Mention which post the answer came from.
                        """)
                .defaultAdvisors(QuestionAnswerAdvisor.builder(vectorStore)
                        .searchRequest(SearchRequest.builder()
                                .topK(5)
                                .similarityThreshold(0.4)
                                .build())
                        .build())
                .build();
    }

    record Question(String question) {}
    record Answer(String answer) {}

    @PostMapping("/chat")
    Answer chat(@RequestBody Question question) {
        return new Answer(chatClient.prompt()
                .user(question.question())
                .call()
                .content());
    }
}
```

Every request now automatically: embeds the question, pulls the top 5 chunks above the similarity threshold, prepends them to the prompt, and sends the whole thing to the local model. The controller reads like a normal REST endpoint because it is one.

Try it against the sample corpus:

```bash
curl -s localhost:8080/chat -H 'Content-Type: application/json' \
  -d '{"question": "What do cats like to do"}'
```

```json
{"answer":"Cats like to engage in behaviors such as knocking things off tables, which stems from their natural hunting instincts, curiosity, and playfulness. This behavior helps them test objects in their environment, seek attention, or simply enjoy the interaction. The answer comes from the blog post **\"Why Cats Knock Things Off Tables\"** (2026-01-05)."}
```

The model pulls the right chunk out of the three cat posts and cites the specific one it came from. That citation is the whole point of the exercise — swap in your own markdown as the corpus and you'll know instantly when retrieval pulls the wrong document, because the answer will name the wrong source.

## Tuning What Actually Matters

Things that moved the quality needle for me, in order:

1. **`temperature: 0.2`** — RAG answers should be boring. High temperature makes the model embellish beyond the retrieved context.
2. **The "say you don't know" instruction** — without it, small local models will confidently answer from training data when retrieval comes back empty. The `similarityThreshold` plus this instruction is your hallucination defense.
3. **`topK`** — 5 chunks ≈ 2,000 tokens of context. More is not better; local models degrade noticeably as you stuff the context window.
4. **Model choice last** — I got more improvement from the three items above than from swapping chat models. Fix retrieval before reaching for a bigger model.

## Where This Falls Over (Honest Limits)

- **Throughput.** One Ollama instance processes requests essentially serially. Fine for a team tool, wrong for public traffic.
- **`SimpleVectorStore` rebuilds on restart** unless you use its save/load to persist the embeddings JSON. Past a few thousand chunks, move to pgvector.
- **Small-model reasoning.** Multi-hop questions ("compare what he said about TSID vs Leyden") are where 8B models visibly strain. Better chunking helps; sometimes you just need a bigger model.

## Summary

Spring AI plus Ollama gives you the full modern AI stack — chat, embeddings, vector search, RAG — with the operational footprint of a single localhost dependency. The abstractions are genuinely portable: everything in this post except the `ollama:` config block works unchanged against OpenAI, Anthropic, or a beefier self-hosted server.

Clone the [demo project](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/spring-ai-ollama-rag) and it runs out of the box against the three sample cat posts in `corpus/` — ask it what cats like to do and watch it cite its source. Swap those files for your own markdown and you'll have a private RAG chatbot over your own documents in about ten minutes — most of which is the model download.

[spring-ai-docs]: https://docs.spring.io/spring-ai/reference/
[ollama]: https://ollama.com
[nomic-embed]: https://ollama.com/library/nomic-embed-text
