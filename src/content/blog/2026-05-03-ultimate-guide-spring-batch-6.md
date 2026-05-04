---
author: StevenPG
pubDatetime: 2026-05-03T12:00:00.000Z
title: "The Ultimate Guide to Spring Batch 6"
slug: ultimate-guide-spring-batch-6
featured: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - spring batch
  - batch processing
description: A deep-dive guide to Spring Batch 6 — covering architecture, chunk processing, readers/writers, fault tolerance, partitioning, testing, and every meaningful change from Spring Batch 5.
---

# The Ultimate Guide to Spring Batch 6

## Table of Contents

[[toc]]

## Introduction

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. Spring Batch 6 shipped alongside Spring Boot 4.0 in late 2025, and while the core concepts haven't changed, the API surface has been meaningfully cleaned up and extended. A lot of what you'd find in older tutorials still references the deprecated factory-based setup from Spring Batch 4 or the transitional APIs from Spring Batch 5. This guide is the up-to-date version.

This isn't a "hello world with a CSV" post. We're going to cover the full breadth of Spring Batch — architecture, chunk-oriented processing, every major reader and writer, fault tolerance, partitioning, listeners, testing, and observability — and show where Spring Batch 6 specifically changed things from version 5. Every code snippet reflects the current Spring Batch 6 API.

If you're migrating from Spring Batch 5, there's a dedicated section at the end covering every breaking change. If you're starting fresh, you can read straight through.

## Architecture Overview

Spring Batch is built around a small number of abstractions that compose cleanly. Understanding them upfront makes everything else obvious.

```
JobLauncher
    └─► Job
           ├─► Step 1 (Chunk-oriented)
           │       ├─ ItemReader
           │       ├─ ItemProcessor (optional)
           │       └─ ItemWriter
           ├─► Step 2 (Tasklet)
           └─► Step 3 (Partitioned)
                    ├─ Worker Step (partition 0)
                    ├─ Worker Step (partition 1)
                    └─ Worker Step (partition 2)
```

**Job** — the top-level unit of work. A job has a name, a sequence of steps, and can be parameterized. Each distinct execution is a `JobInstance`, and each attempt at running an instance is a `JobExecution`.

**Step** — a single phase of a job. Steps are either chunk-oriented (read → process → write in batches) or tasklet-based (arbitrary logic). A step tracks its own `StepExecution` with counters for reads, writes, skips, and failures.

**JobRepository** — persists all execution state. Every job instance, job execution, and step execution is stored here. This is what gives Spring Batch its restart-from-failure capability. Out of the box it's backed by a JDBC datasource; there's also an in-memory implementation for testing.

**JobLauncher** — the entry point for starting a job. You hand it a `Job` and `JobParameters`, it talks to the `JobRepository` to check whether this instance has run before, and it fires the execution.

**ItemReader / ItemProcessor / ItemWriter** — the three interfaces that define chunk-oriented processing. The framework calls `read()` until it returns null, accumulates items into a chunk, runs them through `process()`, then calls `write()` with the whole chunk. On failure, it can retry or skip individual items depending on your configuration.

### The JobRepository Schema

Spring Batch needs six tables in your database. When you run with `spring.batch.jdbc.initialize-schema=always`, they're created automatically. In production you typically set this to `never` and manage the schema yourself.

```sql
BATCH_JOB_INSTANCE
BATCH_JOB_EXECUTION
BATCH_JOB_EXECUTION_PARAMS
BATCH_JOB_EXECUTION_CONTEXT
BATCH_STEP_EXECUTION
BATCH_STEP_EXECUTION_CONTEXT
```

The `_CONTEXT` tables store serialized `ExecutionContext` — the key/value map that you can use to pass state between steps or checkpoint progress mid-step for restartability.

## Project Setup

### Dependencies

```kotlin
// build.gradle.kts
plugins {
    java
    id("org.springframework.boot") version "4.0.6"
    id("io.spring.dependency-management") version "1.1.7"
}

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-batch")
    implementation("org.springframework.boot:spring-boot-starter-data-jpa")
    implementation("org.springframework.boot:spring-boot-starter-jdbc")
    runtimeOnly("org.postgresql:postgresql")

    compileOnly("org.projectlombok:lombok")
    annotationProcessor("org.projectlombok:lombok")

    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.springframework.boot:spring-boot-testcontainers")
    testImplementation("org.springframework.batch:spring-batch-test")
    testImplementation("org.testcontainers:testcontainers-postgresql")
    testCompileOnly("org.projectlombok:lombok")
    testAnnotationProcessor("org.projectlombok:lombok")
}

tasks.withType<Test> {
    useJUnitPlatform()
}
```

### Configuration

Spring Batch 6 prefers extending `JdbcDefaultBatchConfiguration` over annotating with `@EnableBatchProcessing`. This gives you type-safe overrides instead of attribute-based configuration.

`JdbcDefaultBatchConfiguration` is the concrete JDBC-backed subclass that wires the `JobRepository`, `JobLauncher`, and related infrastructure to your datasource. When Spring Data JPA is also on the classpath it registers its own `JpaTransactionManager`, which creates an ambiguity. The solution is to expose a named `batchTransactionManager` bean and reference it by qualifier in every step builder.

```java
@Configuration
public class BatchConfig extends JdbcDefaultBatchConfiguration {

    @Autowired
    private DataSource dataSource;

    @Bean
    public PlatformTransactionManager batchTransactionManager() {
        return new JdbcTransactionManager(dataSource);
    }

    @Override
    protected DataSource getDataSource() {
        return dataSource;
    }

    @Override
    protected PlatformTransactionManager getTransactionManager() {
        return batchTransactionManager();
    }
}
```

You only override what you need to change. `getTransactionManager()` delegates back to the `@Bean` method so the CGLIB proxy ensures a single instance is shared between the batch infrastructure and your step builders.

**`application.yml`:**

```yaml
spring:
  batch:
    jdbc:
      initialize-schema: never   # manage schema manually; see schema.sql
    job:
      enabled: false             # don't auto-run jobs on startup
  datasource:
    url: jdbc:postgresql://localhost:5432/batchdb
    username: batch
    password: batch
    driver-class-name: org.postgresql.Driver
  jpa:
    hibernate:
      ddl-auto: update           # use validate or none in production
    show-sql: false
```

Setting `spring.batch.job.enabled=false` is important if you don't want jobs to run automatically when the application starts. You'll trigger them via `JobLauncher` from a controller, a scheduler, or a message listener instead.

## Defining Jobs and Steps

Spring Batch 6 uses the builder pattern directly. The `JobBuilderFactory` and `StepBuilderFactory` from Spring Batch 4 were deprecated in version 5 and are fully removed in version 6.

When Spring Data JPA is on the classpath you need to qualify the transaction manager by name so Spring resolves `batchTransactionManager` rather than the auto-configured `JpaTransactionManager`.

```java
@Configuration
public class ImportJobConfig {

    @Bean
    public Job importJob(JobRepository jobRepository,
                         Step validateStep, Step importStep, Step reportStep) {
        return new JobBuilder("importJob", jobRepository)
                .start(validateStep)
                .next(importStep)
                .next(reportStep)
                .build();
    }

    @Bean
    public Step importStep(
            JobRepository jobRepository,
            @Qualifier("batchTransactionManager") PlatformTransactionManager transactionManager,
            ItemReader<OrderRecord> reader,
            ItemProcessor<OrderRecord, Order> processor,
            ItemWriter<Order> writer) {
        return new StepBuilder("importStep", jobRepository)
                .<OrderRecord, Order>chunk(500)
                .transactionManager(transactionManager)
                .reader(reader)
                .processor(processor)
                .writer(writer)
                .build();
    }
}
```

The type parameters on `chunk()` tell the builder the input and output types for the step. The chunk size (500 here) is the number of items per transaction. Larger chunks mean fewer transactions and better throughput; smaller chunks mean finer-grained restart points.

Note the split: `chunk(500)` sets the commit interval and returns a `ChunkOrientedStepBuilder`; `.transactionManager(...)` sets the transaction manager as a separate fluent call. The old `chunk(int, PlatformTransactionManager)` overload that did both at once is deprecated in Spring Batch 6 and will be removed in 7.

### Job Parameters

Job parameters are how you pass runtime data into a job — the file path to import, the date range to process, a run ID. In Spring Batch 5+, parameters are typed rather than stringly-typed.

```java
@Bean
public JobLauncher jobLauncher(JobRepository jobRepository) throws Exception {
    TaskExecutorJobLauncher launcher = new TaskExecutorJobLauncher();
    launcher.setJobRepository(jobRepository);
    launcher.setTaskExecutor(new SyncTaskExecutor());
    launcher.afterPropertiesSet();
    return launcher;
}

// Launching with parameters
public void runImport(String filePath, LocalDate processingDate) throws Exception {
    JobParameters params = new JobParametersBuilder()
            .addString("filePath", filePath)
            .addLocalDate("processingDate", processingDate)
            .addLong("runId", System.currentTimeMillis()) // ensures uniqueness
            .toJobParameters();

    jobLauncher.run(importJob, params);
}
```

Accessing parameters inside a step requires `@StepScope` and `@Value`:

```java
@Bean
@StepScope
public FlatFileItemReader<OrderRecord> reader(
        @Value("#{jobParameters['filePath']}") String filePath) {

    return new FlatFileItemReaderBuilder<OrderRecord>()
            .name("orderReader")
            .resource(new FileSystemResource(filePath))
            .delimited()
            .names("orderId", "customerId", "amount", "currency")
            .targetType(OrderRecord.class)
            .build();
}
```

`@StepScope` is critical here. It creates a new bean instance per step execution, which is what allows the `@Value` SpEL expression to resolve the actual job parameter at runtime. Without it, the reader is a singleton and the parameter injection happens at context startup — before any job is running.

## Item Readers

Spring Batch ships with a large library of item readers. Here are the ones you'll actually use in production.

### FlatFileItemReader

For CSV, TSV, and fixed-width files.

For Java records (immutable — no setters) or any type that needs custom field conversion, use a lambda `fieldSetMapper`:

```java
@Bean
@StepScope
public FlatFileItemReader<OrderRecord> csvReader(
        @Value("#{jobParameters['filePath']}") String filePath) {

    return new FlatFileItemReaderBuilder<OrderRecord>()
            .name("orderItemReader")
            .resource(new FileSystemResource(filePath))
            .linesToSkip(1)                          // skip header row
            .delimited()
            .delimiter(",")
            .names("id", "customerId", "productCode", "amount", "orderDate")
            .fieldSetMapper(fieldSet -> new OrderRecord(
                    fieldSet.readString("id"),
                    fieldSet.readString("customerId"),
                    fieldSet.readString("productCode"),
                    parseBigDecimal(fieldSet.readString("amount")),
                    fieldSet.readString("orderDate")
            ))
            .build();
}

private BigDecimal parseBigDecimal(String raw) {
    return (raw == null || raw.isBlank()) ? BigDecimal.ZERO : new BigDecimal(raw.trim());
}
```

For simple JavaBeans with standard setters, `.targetType(MyBean.class)` (which uses `BeanWrapperFieldSetMapper` internally) is the shorter alternative — but it doesn't work for records or types that need type conversion beyond what Spring's `ConversionService` handles out of the box.

For fixed-width files:

```java
@Bean
@StepScope
public FlatFileItemReader<TradeRecord> fixedWidthReader(
        @Value("#{jobParameters['filePath']}") String filePath) {

    return new FlatFileItemReaderBuilder<TradeRecord>()
            .name("fixedWidthReader")
            .resource(new FileSystemResource(filePath))
            .fixedLength()
            .columns(
                new Range(1, 10),   // tradeId
                new Range(11, 20),  // accountId
                new Range(21, 35),  // amount (15 chars)
                new Range(36, 43)   // tradeDate
            )
            .names("tradeId", "accountId", "amount", "tradeDate")
            .targetType(TradeRecord.class)
            .build();
}
```

### JdbcCursorItemReader

Reads rows from a database using a scrolling cursor. The cursor stays open for the duration of the step — efficient, but ties up a database connection.

```java
@Bean
@StepScope
public JdbcCursorItemReader<Order> cursorReader(DataSource dataSource,
        @Value("#{jobParameters['status']}") String status) {

    return new JdbcCursorItemReaderBuilder<Order>()
            .name("orderCursorReader")
            .dataSource(dataSource)
            .sql("SELECT id, customer_id, amount, currency, status " +
                 "FROM orders WHERE status = ? ORDER BY id")
            .preparedStatementSetter(ps -> ps.setString(1, status))
            .rowMapper(new BeanPropertyRowMapper<>(Order.class))
            .build();
}
```

### JdbcPagingItemReader

Reads in pages using `LIMIT`/`OFFSET` (or database-specific equivalents). Preferred over the cursor reader when you want connection pooling or need restartability across multiple JVM instances.

```java
@Bean
@StepScope
public JdbcPagingItemReader<Order> pagingReader(DataSource dataSource,
        @Value("#{jobParameters['processingDate']}") LocalDate date) {

    Map<String, Order> sortKeys = Map.of("id", Order.class); // just for type inference
    
    SqlPagingQueryProviderFactoryBean queryProvider = new SqlPagingQueryProviderFactoryBean();
    queryProvider.setDataSource(dataSource);
    queryProvider.setSelectClause("SELECT id, customer_id, amount, currency");
    queryProvider.setFromClause("FROM orders");
    queryProvider.setWhereClause("WHERE created_date = :processingDate");
    queryProvider.setSortKey("id");

    return new JdbcPagingItemReaderBuilder<Order>()
            .name("orderPagingReader")
            .dataSource(dataSource)
            .queryProvider(queryProvider.getObject())
            .parameterValues(Map.of("processingDate", date))
            .pageSize(1000)
            .rowMapper(new BeanPropertyRowMapper<>(Order.class))
            .build();
}
```

The paging reader stores its current page in `ExecutionContext`, so if the step fails and restarts, it picks up from the last committed page rather than the beginning.

### JpaPagingItemReader

When you want JPA entities rather than raw rows:

```java
@Bean
@StepScope
public JpaPagingItemReader<Order> jpaReader(EntityManagerFactory emf,
        @Value("#{jobParameters['status']}") String status) {

    return new JpaPagingItemReaderBuilder<Order>()
            .name("jpaOrderReader")
            .entityManagerFactory(emf)
            .queryString("SELECT o FROM Order o WHERE o.status = :status ORDER BY o.id")
            .parameterValues(Map.of("status", status))
            .pageSize(500)
            .build();
}
```

JPA readers work well but watch out for the N+1 problem on lazily-loaded associations. Add a `JOIN FETCH` or use `@EntityGraph` on the query.

### JsonItemReader

For newline-delimited JSON files (one JSON object per line):

```java
@Bean
@StepScope
public JsonItemReader<OrderRecord> jsonReader(
        @Value("#{jobParameters['filePath']}") String filePath) {

    return new JsonItemReaderBuilder<OrderRecord>()
            .name("jsonOrderReader")
            .resource(new FileSystemResource(filePath))
            .jsonObjectReader(new JacksonJsonObjectReader<>(OrderRecord.class))
            .build();
}
```

### Building a Custom ItemReader

Sometimes you need to read from an API, a message queue, or a custom data source. Implement `ItemReader<T>` (or `ItemStreamReader<T>` for checkpoint support):

```java
@Component
@StepScope
public class ApiOrderReader implements ItemStreamReader<OrderRecord> {

    private final OrderApiClient client;
    private Iterator<OrderRecord> currentPage;
    private int pageNumber = 0;
    private boolean exhausted = false;

    @Override
    public void open(ExecutionContext executionContext) {
        // Restore state on restart
        if (executionContext.containsKey("page")) {
            pageNumber = executionContext.getInt("page");
        }
        loadNextPage();
    }

    @Override
    public OrderRecord read() {
        if (exhausted) return null;
        if (!currentPage.hasNext()) {
            loadNextPage();
            if (exhausted) return null;
        }
        return currentPage.next();
    }

    @Override
    public void update(ExecutionContext executionContext) {
        // Called after each chunk commit — checkpoint current page
        executionContext.putInt("page", pageNumber);
    }

    private void loadNextPage() {
        List<OrderRecord> page = client.getOrders(pageNumber, 500);
        if (page.isEmpty()) {
            exhausted = true;
        } else {
            currentPage = page.iterator();
            pageNumber++;
        }
    }
}
```

The `update()` method is the key to restartability. It's called after each successful chunk commit, so the page number is checkpointed to the database. On restart, `open()` restores it and picks up from the right page.

## Item Processors

Processors transform items read from the source into the form needed by the writer. They're optional — if your reader output type matches your writer input type, you can leave the processor out.

### Basic Processor

```java
@Component
public class OrderProcessor implements ItemProcessor<OrderRecord, Order> {

    private final CustomerRepository customerRepo;
    private final ExchangeRateService fxService;

    @Override
    public Order process(OrderRecord record) throws Exception {
        Customer customer = customerRepo.findById(record.getCustomerId())
                .orElseThrow(() -> new CustomerNotFoundException(record.getCustomerId()));

        BigDecimal amountUsd = fxService.convertToUsd(
                record.getAmount(), record.getCurrency());

        return Order.builder()
                .id(record.getOrderId())
                .customer(customer)
                .amountUsd(amountUsd)
                .status(OrderStatus.PENDING)
                .build();
    }
}
```

Returning `null` from `process()` filters the item — it won't be passed to the writer. This is the right way to implement filtering logic in a processor.

### CompositeItemProcessor

Chain multiple processors together:

```java
@Bean
public CompositeItemProcessor<OrderRecord, Order> processor(
        ValidationProcessor validationProcessor,
        EnrichmentProcessor enrichmentProcessor,
        NormalizationProcessor normalizationProcessor) {

    CompositeItemProcessor<OrderRecord, Order> composite = new CompositeItemProcessor<>();
    composite.setDelegates(List.of(
            validationProcessor,
            enrichmentProcessor,
            normalizationProcessor
    ));
    return composite;
}
```

Items flow through each delegate in order. If any delegate returns null, the item is filtered and no further delegates are called.

### ValidatingItemProcessor

Integrates with Spring's `Validator` or the `org.springframework.batch.item.validator.Validator` interface:

```java
@Bean
public ValidatingItemProcessor<OrderRecord> validatingProcessor(
        LocalValidatorFactoryBean validator) {

    ValidatingItemProcessor<OrderRecord> processor = new ValidatingItemProcessor<>();
    processor.setValidator(new SpringValidator<>(validator));
    processor.setFilter(false); // throw exception instead of filtering invalid items
    return processor;
}
```

With `setFilter(true)`, invalid items are silently dropped. With `setFilter(false)`, a `ValidationException` is thrown — you can then configure skip/retry behavior on the step to handle it.

## Item Writers

### JdbcBatchItemWriter

The most common writer for relational databases. Uses batched `PreparedStatement` execution for high throughput.

```java
@Bean
public JdbcBatchItemWriter<Order> jdbcWriter(DataSource dataSource) {
    return new JdbcBatchItemWriterBuilder<Order>()
            .dataSource(dataSource)
            .sql("INSERT INTO orders (id, customer_id, amount_usd, status, created_at) " +
                 "VALUES (:id, :customerId, :amountUsd, :status, :createdAt) " +
                 "ON CONFLICT (id) DO UPDATE SET " +
                 "amount_usd = EXCLUDED.amount_usd, status = EXCLUDED.status")
            .beanMapped()      // maps :paramName to bean properties
            .build();
}
```

For fine-grained control over parameter binding:

```java
@Bean
public JdbcBatchItemWriter<Order> jdbcWriter(DataSource dataSource) {
    return new JdbcBatchItemWriterBuilder<Order>()
            .dataSource(dataSource)
            .sql("INSERT INTO orders (id, customer_id, amount_usd) VALUES (?, ?, ?)")
            .itemPreparedStatementSetter((order, ps) -> {
                ps.setString(1, order.getId());
                ps.setString(2, order.getCustomerId());
                ps.setBigDecimal(3, order.getAmountUsd());
            })
            .build();
}
```

### FlatFileItemWriter

Writing to CSV or other flat files:

```java
@Bean
@StepScope
public FlatFileItemWriter<Order> csvWriter(
        @Value("#{jobParameters['outputPath']}") String outputPath) {

    return new FlatFileItemWriterBuilder<Order>()
            .name("orderCsvWriter")
            .resource(new FileSystemResource(outputPath))
            .delimited()
            .delimiter(",")
            .names("id", "customerId", "amountUsd", "status")
            .headerCallback(writer -> writer.write("id,customer_id,amount_usd,status"))
            .build();
}
```

For appending to existing files rather than overwriting:

```java
return new FlatFileItemWriterBuilder<Order>()
        .name("orderCsvWriter")
        .resource(new FileSystemResource(outputPath))
        .appendAllowed(true)
        // ...
        .build();
```

### CompositeItemWriter

Write to multiple destinations in the same step:

```java
@Bean
public CompositeItemWriter<Order> compositeWriter(
        JdbcBatchItemWriter<Order> dbWriter,
        FlatFileItemWriter<Order> auditWriter,
        KafkaItemWriter<String, Order> eventWriter) {

    CompositeItemWriter<Order> writer = new CompositeItemWriter<>();
    writer.setDelegates(List.of(dbWriter, auditWriter, eventWriter));
    return writer;
}
```

All delegates receive the same chunk. If any delegate throws, the whole chunk is rolled back — the transaction boundary wraps all writers.

### ClassifierCompositeItemWriter

Route items to different writers based on a condition:

```java
@Bean
public ClassifierCompositeItemWriter<Order> routingWriter(
        JdbcBatchItemWriter<Order> domesticWriter,
        JdbcBatchItemWriter<Order> internationalWriter) {

    BackToBackPatternClassifier classifier = new BackToBackPatternClassifier();
    classifier.setRouterDelegate((Classifier<Order, String>) order ->
            order.getCurrency().equals("USD") ? "domestic" : "international");
    classifier.setMatcherMap(Map.of(
            "domestic", domesticWriter,
            "international", internationalWriter
    ));

    ClassifierCompositeItemWriter<Order> writer = new ClassifierCompositeItemWriter<>();
    writer.setClassifier(classifier);
    return writer;
}
```

## Fault Tolerance

Spring Batch's fault tolerance configuration is one of the things tutorials usually gloss over. Here's the full picture.

### Skip

Configure the step to skip certain exception types rather than failing the job:

```java
@Bean
public Step importStep(ItemReader<OrderRecord> reader,
                       ItemProcessor<OrderRecord, Order> processor,
                       ItemWriter<Order> writer) {
    return new StepBuilder("importStep", jobRepository)
            .<OrderRecord, Order>chunk(500)
            .transactionManager(transactionManager)
            .reader(reader)
            .processor(processor)
            .writer(writer)
            .faultTolerant()
            .skip(ValidationException.class)
            .skip(DataIntegrityViolationException.class)
            .skipLimit(100)           // fail the step if more than 100 items skipped
            .build();
}
```

Only add exception types you want skipped. Anything not in the skip list is implicitly never skipped — the old `.noSkip()` method that existed on `FaultTolerantStepBuilder` is not present on `ChunkOrientedStepBuilder` and is no longer needed.

When a skip happens, Spring Batch re-processes the failed chunk one item at a time to isolate exactly which item caused the error. This is called the "single-item retry" pass — you'll see it in logs as the chunk size dropping to 1.

### Retry

Configure the step to retry individual items on transient failures:

```java
return new StepBuilder("importStep", jobRepository)
        .<OrderRecord, Order>chunk(500)
        .transactionManager(transactionManager)
        .reader(reader)
        .processor(processor)
        .writer(writer)
        .faultTolerant()
        .retry(TransientDataAccessException.class)
        .retry(OptimisticLockingFailureException.class)
        .retryLimit(3)
        .build();
```

Only add exception types you want retried. The old `.noRetry()` method is not present on `ChunkOrientedStepBuilder` — exceptions not in the retry list are implicitly not retried.

Retry wraps the `process()` and `write()` calls. If a retryable exception is thrown, the item is retried up to `retryLimit` times before it's treated as a skip (if skip is configured) or a failure.

### Skip and Retry Together

Both can be combined on the same step. The typical pattern is to retry transient infrastructure errors and skip permanent data quality errors:

```java
return new StepBuilder("importStep", jobRepository)
        .<OrderRecord, Order>chunk(500)
        .transactionManager(transactionManager)
        .reader(reader)
        .processor(processor)
        .writer(writer)
        .faultTolerant()
        // Retry transient errors
        .retry(TransientDataAccessException.class)
        .retryLimit(3)
        // Skip data quality errors
        .skip(ValidationException.class)
        .skip(CustomerNotFoundException.class)
        .skipLimit(50)
        .build();
```

### SkipListener

Know which items were skipped and why:

```java
@Component
public class OrderSkipListener implements SkipListener<OrderRecord, Order> {

    private final SkippedOrderRepository skippedRepo;

    @Override
    public void onSkipInRead(Throwable t) {
        log.warn("Skipped during read: {}", t.getMessage());
    }

    @Override
    public void onSkipInProcess(OrderRecord item, Throwable t) {
        log.warn("Skipped during process: orderId={}, reason={}", 
                item.getOrderId(), t.getMessage());
        skippedRepo.save(new SkippedOrder(item.getOrderId(), t.getMessage(), "PROCESS"));
    }

    @Override
    public void onSkipInWrite(Order item, Throwable t) {
        log.warn("Skipped during write: orderId={}, reason={}",
                item.getId(), t.getMessage());
        skippedRepo.save(new SkippedOrder(item.getId(), t.getMessage(), "WRITE"));
    }
}
```

Register it on the step:

```java
return new StepBuilder("importStep", jobRepository)
        .<OrderRecord, Order>chunk(500)
        .transactionManager(transactionManager)
        // ...
        .faultTolerant()
        .skip(ValidationException.class)
        .skipLimit(100)
        .listener(orderSkipListener)
        .build();
```

## Listeners

Listeners are hooks into the Spring Batch lifecycle. They let you add cross-cutting behavior without polluting your reader/processor/writer logic.

### JobExecutionListener

```java
@Component
public class ImportJobListener implements JobExecutionListener {

    private final NotificationService notifier;

    @Override
    public void beforeJob(JobExecution jobExecution) {
        log.info("Starting job: {}, params: {}",
                jobExecution.getJobInstance().getJobName(),
                jobExecution.getJobParameters());
    }

    @Override
    public void afterJob(JobExecution jobExecution) {
        BatchStatus status = jobExecution.getStatus();
        long elapsed = Duration.between(
                jobExecution.getStartTime(),
                jobExecution.getEndTime()).toSeconds();

        if (status == BatchStatus.COMPLETED) {
            notifier.sendSuccess("Import completed in " + elapsed + "s");
        } else if (status == BatchStatus.FAILED) {
            jobExecution.getAllFailureExceptions()
                    .forEach(ex -> notifier.sendFailure(ex.getMessage()));
        }
    }
}
```

### StepExecutionListener

```java
@Component
public class MetricsStepListener implements StepExecutionListener {

    private final MeterRegistry meterRegistry;

    @Override
    public void beforeStep(StepExecution stepExecution) {
        log.info("Starting step: {}", stepExecution.getStepName());
    }

    @Override
    public ExitStatus afterStep(StepExecution stepExecution) {
        meterRegistry.counter("batch.items.read",
                "step", stepExecution.getStepName())
                .increment(stepExecution.getReadCount());
        meterRegistry.counter("batch.items.written",
                "step", stepExecution.getStepName())
                .increment(stepExecution.getWriteCount());
        meterRegistry.counter("batch.items.skipped",
                "step", stepExecution.getStepName())
                .increment(stepExecution.getSkipCount());

        // Returning null keeps the step's existing ExitStatus
        // Return a different ExitStatus to override it
        return null;
    }
}
```

### ChunkListener

Called around each chunk transaction:

```java
@Component
public class ProgressChunkListener implements ChunkListener {

    @Override
    public void beforeChunk(ChunkContext context) {
        // Called before the chunk's read-process-write cycle
    }

    @Override
    public void afterChunk(ChunkContext context) {
        StepExecution step = context.getStepContext().getStepExecution();
        log.debug("Committed chunk. Total written: {}", step.getWriteCount());
    }

    @Override
    public void afterChunkError(ChunkContext context) {
        log.error("Chunk failed. Step: {}", 
                context.getStepContext().getStepName());
    }
}
```

### ItemReadListener, ItemProcessListener, ItemWriteListener

For item-level hooks:

```java
@Component
public class AuditItemListener 
        implements ItemReadListener<OrderRecord>, 
                   ItemProcessListener<OrderRecord, Order>,
                   ItemWriteListener<Order> {

    @Override
    public void onReadError(Exception ex) {
        log.error("Read error: {}", ex.getMessage());
    }

    @Override
    public void afterProcess(OrderRecord item, Order result) {
        if (result == null) {
            log.debug("Item filtered: {}", item.getOrderId());
        }
    }

    @Override
    public void onProcessError(OrderRecord item, Exception e) {
        log.error("Process error for order {}: {}", item.getOrderId(), e.getMessage());
    }

    @Override
    public void onWriteError(Exception exception, Chunk<? extends Order> items) {
        log.error("Write error for {} items: {}", items.size(), exception.getMessage());
    }
}
```

## Tasklet Steps

Not everything fits the chunk model. For steps that need to do one thing — truncate a table, move a file, call an API, send an email — use a `Tasklet`.

```java
@Component
public class CleanupTasklet implements Tasklet {

    private final JdbcTemplate jdbc;
    private final FileCleanupService fileService;

    @Override
    public RepeatStatus execute(StepContribution contribution, ChunkContext chunkContext) {
        // Delete processing artifacts older than 30 days
        int deleted = jdbc.update(
                "DELETE FROM processing_artifacts WHERE created_at < NOW() - INTERVAL '30 days'");
        contribution.incrementWriteCount(deleted);

        // Clean up temp files
        fileService.deleteTempFiles(Duration.ofDays(30));

        return RepeatStatus.FINISHED;
    }
}
```

Wire it up as a step:

```java
@Bean
public Step cleanupStep(CleanupTasklet cleanupTasklet) {
    return new StepBuilder("cleanupStep", jobRepository)
            .tasklet(cleanupTasklet, transactionManager)
            .build();
}
```

`RepeatStatus.FINISHED` ends the step. `RepeatStatus.CONTINUABLE` causes the tasklet to be called again — useful for polling loops, though a `while` loop inside `execute()` is usually cleaner.

## Step Flow and Conditional Branching

Jobs don't have to run steps linearly. You can branch based on a step's exit status.

### Conditional Flow

```java
@Bean
public Job importJob(Step validateStep, Step importStep, 
                     Step repairStep, Step reportStep) {
    return new JobBuilder("importJob", jobRepository)
            .start(validateStep)
                .on("FAILED").to(repairStep)
                    .from(repairStep).on("COMPLETED").to(importStep)
                    .from(repairStep).on("FAILED").end()
            .from(validateStep)
                .on("COMPLETED").to(importStep)
            .from(importStep).next(reportStep)
            .end()
            .build();
}
```

Exit status strings come from the step's `ExitStatus`. Spring Batch uses `COMPLETED`, `FAILED`, `STOPPED`, and `UNKNOWN` as built-ins, but you can return custom strings from a `StepExecutionListener.afterStep()` to drive more complex routing.

### JobExecutionDecider

For routing logic that's more complex than a simple status check:

```java
@Component
public class ImportRouteDecider implements JobExecutionDecider {

    @Override
    public FlowExecutionStatus decide(JobExecution jobExecution, StepExecution stepExecution) {
        long itemCount = stepExecution.getReadCount();
        if (itemCount == 0) {
            return new FlowExecutionStatus("EMPTY");
        } else if (itemCount > 1_000_000) {
            return new FlowExecutionStatus("LARGE");
        }
        return new FlowExecutionStatus("NORMAL");
    }
}
```

```java
@Bean
public Job importJob(Step importStep, Step largeImportStep, Step notifyEmptyStep,
                     Step reportStep, ImportRouteDecider decider) {
    return new JobBuilder("importJob", jobRepository)
            .start(importStep)
            .next(decider)
                .on("EMPTY").to(notifyEmptyStep)
                .on("LARGE").to(largeImportStep)
                .on("NORMAL").to(reportStep)
            .end()
            .build();
}
```

## Partitioned Steps

Partitioning is Spring Batch's mechanism for parallelizing work across multiple threads or JVM instances. A **Manager** step divides the data into partitions; **Worker** steps process each partition independently.

### Local Partitioning (Multi-threaded)

```java
@Bean
public Step partitionedImportStep(Step workerStep) {
    return new StepBuilder("partitionedImportStep", jobRepository)
            .partitioner("workerStep", dateRangePartitioner())
            .step(workerStep)
            .gridSize(8)               // 8 partitions
            .taskExecutor(taskExecutor())
            .build();
}

@Bean
public ThreadPoolTaskExecutor taskExecutor() {
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    executor.setCorePoolSize(8);
    executor.setMaxPoolSize(8);
    executor.setQueueCapacity(0);
    executor.afterPropertiesSet();
    return executor;
}
```

The `Partitioner` creates the `ExecutionContext` for each partition:

```java
@Component
public class DateRangePartitioner implements Partitioner {

    @Override
    public Map<String, ExecutionContext> partition(int gridSize) {
        Map<String, ExecutionContext> partitions = new LinkedHashMap<>();

        LocalDate start = LocalDate.of(2024, 1, 1);
        LocalDate end = LocalDate.of(2024, 12, 31);
        long totalDays = ChronoUnit.DAYS.between(start, end) + 1;
        long daysPerPartition = (totalDays + gridSize - 1) / gridSize;

        for (int i = 0; i < gridSize; i++) {
            LocalDate partitionStart = start.plusDays((long) i * daysPerPartition);
            LocalDate partitionEnd = partitionStart.plusDays(daysPerPartition - 1);
            if (partitionEnd.isAfter(end)) partitionEnd = end;

            ExecutionContext context = new ExecutionContext();
            context.put("startDate", partitionStart.toString());
            context.put("endDate", partitionEnd.toString());

            partitions.put("partition" + i, context);
        }
        return partitions;
    }
}
```

The worker step reads its date range from `ExecutionContext` via `@StepScope`:

```java
@Bean
@StepScope
public JdbcPagingItemReader<Order> workerReader(DataSource dataSource,
        @Value("#{stepExecutionContext['startDate']}") String startDate,
        @Value("#{stepExecutionContext['endDate']}") String endDate) {

    // ... configure reader for the date range
}
```

### Range-Based Column Partitioning

For database tables, partitioning by ID range is common and efficient:

```java
@Component
public class ColumnRangePartitioner implements Partitioner {

    private final JdbcTemplate jdbc;
    private final String table;
    private final String column;

    @Override
    public Map<String, ExecutionContext> partition(int gridSize) {
        Map<String, Object> minMax = jdbc.queryForMap(
                "SELECT MIN(" + column + ") as min, MAX(" + column + ") as max FROM " + table);

        long min = ((Number) minMax.get("min")).longValue();
        long max = ((Number) minMax.get("max")).longValue();
        long size = (max - min) / gridSize + 1;

        Map<String, ExecutionContext> result = new LinkedHashMap<>();
        long number = 0;
        long start = min;
        long end = start + size - 1;

        while (start <= max) {
            ExecutionContext ctx = new ExecutionContext();
            ctx.putLong("minValue", start);
            ctx.putLong("maxValue", end);
            result.put("partition" + number, ctx);
            start += size;
            end += size;
            number++;
        }
        return result;
    }
}
```

### File-Based Line Range Partitioning

For flat-file imports, you can divide by line ranges instead of database column values. Each worker receives `minLine`/`maxLine` bounds and skips directly to its slice of the file. Because the partitioner needs to count lines at step-launch time, it must be `@StepScope` so the `filePath` job parameter is resolved before `partition()` is called.

```java
@Component
@StepScope
public class ColumnRangePartitioner implements Partitioner {

    private final String filePath;

    public ColumnRangePartitioner(
            @Value("#{jobParameters['filePath']}") String filePath) {
        this.filePath = filePath;
    }

    @Override
    public Map<String, ExecutionContext> partition(int gridSize) {
        int totalLines = countDataLines();

        Map<String, ExecutionContext> partitions = new HashMap<>(gridSize);
        int baseSize = totalLines / gridSize;
        int remainder = totalLines % gridSize;
        int currentLine = 1;

        for (int i = 0; i < gridSize; i++) {
            // Last partition absorbs any remainder lines
            int size = (i == gridSize - 1) ? baseSize + remainder : baseSize;

            ExecutionContext ctx = new ExecutionContext();
            ctx.putInt("minLine", currentLine);
            ctx.putInt("maxLine", currentLine + size - 1);
            ctx.putString("filePath", filePath);
            partitions.put("partition" + i, ctx);

            currentLine += size;
        }
        return partitions;
    }

    private int countDataLines() {
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(
                        new FileSystemResource(filePath).getInputStream()))) {
            int count = 0;
            while (reader.readLine() != null) count++;
            return Math.max(0, count - 1); // subtract header row
        } catch (IOException e) {
            throw new IllegalStateException("Failed to count lines: " + filePath, e);
        }
    }
}
```

The worker reader pulls `minLine` and `maxLine` from `stepExecutionContext` via `@StepScope` and uses `linesToSkip` plus a line-count limit to read only its assigned range.

## Multi-threaded Steps

A simpler alternative to partitioning when your reader is thread-safe. The step runs the read-process-write cycle across multiple threads simultaneously.

```java
@Bean
public Step multiThreadedStep(ItemReader<Order> reader,
                              ItemProcessor<Order, ProcessedOrder> processor,
                              ItemWriter<ProcessedOrder> writer) {
    return new StepBuilder("multiThreadedStep", jobRepository)
            .<Order, ProcessedOrder>chunk(100)
            .transactionManager(transactionManager)
            .reader(reader)
            .processor(processor)
            .writer(writer)
            .taskExecutor(taskExecutor())
            .build();
}
```

Concurrency is controlled by the `TaskExecutor` pool size — `throttleLimit()`, which existed on the old `SimpleStepBuilder`, is not present on `ChunkOrientedStepBuilder`. Set `corePoolSize` and `maxPoolSize` on your `ThreadPoolTaskExecutor` to cap parallelism instead.

**Important:** most of the built-in readers are not thread-safe. Use `SynchronizedItemStreamReader` to wrap them:

```java
@Bean
@StepScope
public SynchronizedItemStreamReader<Order> synchronizedReader(
        JdbcCursorItemReader<Order> delegate) {
    return new SynchronizedItemStreamReaderBuilder<Order>()
            .delegate(delegate)
            .build();
}
```

The paging readers (`JdbcPagingItemReader`, `JpaPagingItemReader`) are not safe for multi-threaded steps at all — use the cursor readers with `SynchronizedItemStreamReader`, or use partitioning instead.

## Remote Chunking and Remote Partitioning

For distributing work across multiple JVM instances, Spring Batch integrates with Spring Integration or Spring Cloud Task. This is out of scope for a single-JVM guide, but the important thing to know is that the core abstractions are the same — the `Partitioner`, `StepExecutionSplitter`, and `PartitionHandler` interfaces are what change, not your readers and writers.

## Testing

Spring Batch ships with dedicated testing support in `spring-batch-test`. Spring Batch 6 renamed the primary test utility: `JobLauncherTestUtils` is gone, replaced by `JobOperatorTestUtils`. `@SpringBatchTest` wires it up automatically.

### Testcontainers for Integration Tests

Prefer a real PostgreSQL instance in tests over H2 — PostgreSQL-specific SQL (e.g. `ON CONFLICT ... DO UPDATE`) doesn't exist in H2 without a compatibility mode that still has gaps. The cleanest approach is a `@TestConfiguration` that publishes a `PostgreSQLContainer` bean:

```java
@TestConfiguration(proxyBeanMethods = false)
public class TestBatchConfig {

    @Bean
    @ServiceConnection
    PostgreSQLContainer<?> postgresContainer() {
        return new PostgreSQLContainer<>("postgres:16-alpine");
    }
}
```

`@ServiceConnection` (from `spring-boot-testcontainers`) auto-configures the datasource URL, username, and password from the running container — no manual properties needed. Import this class on any test that needs batch infrastructure.

The test profile's `application-test.yml` only needs to override the schema init mode; the datasource comes from the container:

```yaml
# application-test.yml
spring:
  batch:
    job:
      enabled: false
  jpa:
    hibernate:
      ddl-auto: create-drop
  sql:
    init:
      mode: always
      schema-locations:
        - classpath:org/springframework/batch/core/schema-postgresql.sql
```

### Testing a Step in Isolation

`@SpringBatchTest` registers `JobOperatorTestUtils` and `JobRepositoryTestUtils` as beans. `startStep()` runs a single named step without the surrounding job flow:

```java
@SpringBatchTest
@SpringBootTest
@ActiveProfiles("test")
@Import(TestBatchConfig.class)
class ImportStepTest {

    @Autowired
    private JobOperatorTestUtils jobOperatorTestUtils;

    @Autowired
    private JobRepositoryTestUtils jobRepositoryTestUtils;

    @BeforeEach
    void cleanUp() {
        jobRepositoryTestUtils.removeJobExecutions();
    }

    @Test
    void importStep_readsWritesSkipsAndFiltersCorrectly() throws Exception {
        File csvFile = new ClassPathResource("test-orders.csv").getFile();

        JobParameters params = new JobParametersBuilder()
                .addString("filePath", csvFile.getAbsolutePath())
                .addLong("runId", System.currentTimeMillis())
                .toJobParameters();

        JobExecution execution = jobOperatorTestUtils.startStep(
                "importStep", params, new ExecutionContext());

        StepExecution step = execution.getStepExecutions().iterator().next();

        assertThat(step.getStatus()).isEqualTo(BatchStatus.COMPLETED);
        assertThat(step.getReadCount()).isEqualTo(13);
        assertThat(step.getWriteCount()).isEqualTo(10);
        assertThat(step.getProcessSkipCount()).isEqualTo(2);
        assertThat(step.getFilterCount()).isEqualTo(1);
    }
}
```

Note `getProcessSkipCount()` rather than `getSkipCount()`. `StepExecution` tracks skips per phase — `getReadSkipCount()`, `getProcessSkipCount()`, `getWriteSkipCount()` — and `getSkipCount()` is the sum of all three. Using the phase-specific accessor makes assertions precise.

Also note that `ClassPathResource.getFile()` is used to get an absolute filesystem path — the `validateStep` checks `File.exists()`, which requires a real path, not a classpath URL.

### Testing the Full Job

`startJob()` runs the complete job flow including all steps:

```java
@SpringBatchTest
@SpringBootTest
@ActiveProfiles("test")
@Import(TestBatchConfig.class)
class FullImportJobTest {

    @Autowired
    private JobOperatorTestUtils jobOperatorTestUtils;

    @Autowired
    private JobRepositoryTestUtils jobRepositoryTestUtils;

    @BeforeEach
    void cleanUp() {
        jobRepositoryTestUtils.removeJobExecutions();
    }

    @Test
    void fullJob_completesSuccessfully() throws Exception {
        File csvFile = new ClassPathResource("test-orders.csv").getFile();

        JobParameters params = new JobParametersBuilder()
                .addString("filePath", csvFile.getAbsolutePath())
                .addLong("runId", System.currentTimeMillis())
                .toJobParameters();

        JobExecution execution = jobOperatorTestUtils.startJob(params);

        assertThat(execution.getStatus()).isEqualTo(BatchStatus.COMPLETED);

        assertThat(execution.getStepExecutions())
                .extracting(StepExecution::getStepName)
                .containsExactlyInAnyOrder("validateStep", "importStep", "reportStep");
    }
}
```

### Testing Processors

Processors are plain Java — test them as unit tests without loading a Spring context:

```java
class OrderItemProcessorTest {

    private OrderItemProcessor processor;

    @BeforeEach
    void setUp() {
        processor = new OrderItemProcessor();
    }

    @Test
    void validRecord_returnsMappedOrder() throws Exception {
        OrderRecord record = new OrderRecord(
                "ORD001", "C001", "PROD-A", new BigDecimal("99.99"), "2024-01-01");

        Order result = processor.process(record);

        assertThat(result).isNotNull();
        assertThat(result.getId()).isEqualTo("ORD001");
        assertThat(result.getCustomerName()).isEqualTo("Alice");
        assertThat(result.getAmount()).isEqualByComparingTo("99.99");
    }

    @Test
    void zeroAmount_returnsNull() throws Exception {
        OrderRecord record = new OrderRecord(
                "ORD013", "C002", "PROD-G", BigDecimal.ZERO, "2024-01-13");

        assertThat(processor.process(record)).isNull();
    }

    @Test
    void missingCustomerId_throwsValidationException() {
        OrderRecord record = new OrderRecord(
                "ORD011", "", "PROD-F", new BigDecimal("39.99"), "2024-01-11");

        assertThatThrownBy(() -> processor.process(record))
                .isInstanceOf(ValidationException.class)
                .hasMessageContaining("customerId");
    }
}
```

## Observability

Spring Batch 5 added first-class Micrometer support. In Spring Batch 6, it's enabled by default when Micrometer is on the classpath.

### What Gets Instrumented

Spring Batch automatically creates:

- **Timers** for job executions: `spring.batch.job` with tags for `name` and `status`
- **Timers** for step executions: `spring.batch.step` with tags for `name`, `jobName`, and `status`
- **Counters** for chunk operations: `spring.batch.chunk`
- **Counters** for item operations: `spring.batch.item`

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,metrics,prometheus
  metrics:
    distribution:
      percentiles-histogram:
        spring.batch.job: true
        spring.batch.step: true
```

### Custom Metrics in Listeners

For metrics beyond what the framework provides automatically:

```java
@Component
@RequiredArgsConstructor
public class BatchMetricsListener implements StepExecutionListener {

    private final MeterRegistry registry;

    @Override
    public ExitStatus afterStep(StepExecution stepExecution) {
        String step = stepExecution.getStepName();
        String job = stepExecution.getJobExecution().getJobInstance().getJobName();

        registry.gauge("batch.step.read.count",
                Tags.of("step", step, "job", job),
                stepExecution.getReadCount());

        if (stepExecution.getSkipCount() > 0) {
            registry.counter("batch.step.skips",
                    Tags.of("step", step, "job", job))
                    .increment(stepExecution.getSkipCount());
        }

        return null;
    }
}
```

## The In-Memory JobRepository

For lightweight jobs or jobs that don't need restart capability, `ResourcelessJobRepository` skips all persistence:

```java
@Configuration
public class InMemoryBatchConfig extends JdbcDefaultBatchConfiguration {

    @Override
    protected JobRepository createJobRepository() throws Exception {
        return new ResourcelessJobRepository();
    }
}
```

For integration tests, prefer Testcontainers over H2 — the PostgreSQL-specific upsert syntax (`ON CONFLICT ... DO UPDATE`) doesn't work in H2 without its PostgreSQL compatibility mode, which still has gaps. The `TestBatchConfig` pattern in the Testing section above is the recommended approach.

If you specifically need H2 and your SQL is generic enough:

```yaml
# application-test.yml
spring:
  datasource:
    url: jdbc:h2:mem:testdb;DB_CLOSE_DELAY=-1;MODE=PostgreSQL
  batch:
    jdbc:
      initialize-schema: always
```

## Scheduling Jobs

Spring Batch doesn't include a scheduler. The common patterns are:

### @Scheduled

```java
@Component
@RequiredArgsConstructor
public class ImportJobScheduler {

    private final JobLauncher jobLauncher;
    private final Job importJob;

    @Scheduled(cron = "0 0 2 * * *")  // 2am daily
    public void runImport() throws Exception {
        JobParameters params = new JobParametersBuilder()
                .addLocalDate("date", LocalDate.now())
                .addLong("runId", System.currentTimeMillis())
                .toJobParameters();

        JobExecution execution = jobLauncher.run(importJob, params);
        log.info("Job finished with status: {}", execution.getStatus());
    }
}
```

### Async JobLauncher

The default `SyncTaskExecutor` blocks until the job completes. For web-triggered jobs you want async:

```java
@Bean
public JobLauncher asyncJobLauncher(JobRepository jobRepository) throws Exception {
    TaskExecutorJobLauncher launcher = new TaskExecutorJobLauncher();
    launcher.setJobRepository(jobRepository);
    launcher.setTaskExecutor(new SimpleAsyncTaskExecutor()); // or your thread pool
    launcher.afterPropertiesSet();
    return launcher;
}
```

With async launchers, `jobLauncher.run()` returns immediately with a `JobExecution` in `STARTING` status. You poll the `JobRepository` or use a `JobExecutionListener` to get notified when it completes.

## Virtual Threads (Project Loom)

Spring Batch 6 running on Java 21 can use virtual threads for worker thread pools. This is especially beneficial for I/O-bound batch work (API calls, database reads):

```java
@Bean
public TaskExecutor virtualThreadExecutor() {
    return new TaskExecutorAdapter(Executors.newVirtualThreadPerTaskExecutor());
}

@Bean
public Step partitionedStep(Step workerStep) {
    return new StepBuilder("partitionedStep", jobRepository)
            .partitioner("workerStep", partitioner())
            .step(workerStep)
            .gridSize(50)  // virtual threads are cheap — can use much higher grid sizes
            .taskExecutor(virtualThreadExecutor())
            .build();
}
```

With virtual threads you can set much higher parallelism than with platform threads — tens or hundreds of concurrent workers without tuning a thread pool. The overhead of blocking on I/O essentially disappears.

## Spring Batch 5 → 6 Migration

If you're coming from Spring Batch 5, here's what changed.

### Removed: JobBuilderFactory and StepBuilderFactory

These were deprecated in Spring Batch 5.0.0 and removed in 6.0.

```java
// Spring Batch 4 / early 5 — removed in 6
@Autowired
private JobBuilderFactory jobBuilderFactory;

@Autowired
private StepBuilderFactory stepBuilderFactory;

@Bean
public Job myJob() {
    return jobBuilderFactory.get("myJob")
            .start(myStep())
            .build();
}

// Spring Batch 6 — inject directly
private final JobRepository jobRepository;
private final PlatformTransactionManager transactionManager;

@Bean
public Job myJob() {
    return new JobBuilder("myJob", jobRepository)
            .start(myStep())
            .build();
}
```

### Removed: @EnableBatchProcessing Auto-configuration Side Effects

In Spring Batch 5, using `@EnableBatchProcessing` disabled Spring Boot's auto-configuration. In Spring Batch 6, `JdbcDefaultBatchConfiguration` is the preferred extension point, and `@EnableBatchProcessing` behavior has been further narrowed.

The recommendation: **delete `@EnableBatchProcessing`** and extend `JdbcDefaultBatchConfiguration` instead.

### chunk(int, PlatformTransactionManager) → chunk(int).transactionManager(...)

The two-argument `chunk()` overload on `StepBuilder` is deprecated in 6.0 and removed in 7.0. It also returned the legacy `SimpleStepBuilder`; the new single-argument form returns `ChunkOrientedStepBuilder`.

```java
// Spring Batch 5 — deprecated in 6, removed in 7
new StepBuilder("step", jobRepository)
    .<I, O>chunk(500, transactionManager)
    .faultTolerant()
    .noSkip(FatalException.class)
    .noRetry(ValidationException.class)
    ...

// Spring Batch 6
new StepBuilder("step", jobRepository)
    .<I, O>chunk(500)
    .transactionManager(transactionManager)
    .faultTolerant()
    // noSkip() and noRetry() don't exist — only add what you want skipped/retried
    ...
```

`noSkip()` and `noRetry()` existed on `FaultTolerantStepBuilder` (the type returned by the old `.faultTolerant()` call) and are not present on `ChunkOrientedStepBuilder`. They aren't needed: anything not added to the skip or retry list is already implicitly excluded.

`throttleLimit()` for multi-threaded steps is also gone. Control concurrency via the `TaskExecutor` pool size instead.

### JobLauncherTestUtils → JobOperatorTestUtils

The test utility class was renamed in Spring Batch 6. `@SpringBatchTest` now registers `JobOperatorTestUtils` (not `JobLauncherTestUtils`), and the launch methods changed:

```java
// Spring Batch 5 — removed in 6
jobLauncherTestUtils.launchJob(params);
jobLauncherTestUtils.launchStep("stepName", params);

// Spring Batch 6
jobOperatorTestUtils.startJob(params);
jobOperatorTestUtils.startStep("stepName", params, new ExecutionContext());
```

Additionally, `StepExecution.getSkipCount()` returns the total across all phases. For precise assertions, use the phase-specific accessors: `getReadSkipCount()`, `getProcessSkipCount()`, `getWriteSkipCount()`.

### Java 21 Minimum

Spring Batch 6 requires Java 21 (up from Java 17 in Spring Batch 5). If you're on 17, upgrade first.

### JobParameters API Changes

Spring Batch 5 replaced the old untyped `JobParameter` with typed variants. In Spring Batch 6, the typed API is the only option — the string-keyed untyped parameters are gone.

```java
// Old — not available in 5+
new JobParametersBuilder()
        .addString("date", "2024-01-01")
        .addLong("timestamp", System.currentTimeMillis())
        .toJobParameters();

// New — typed, explicit
new JobParametersBuilder()
        .addLocalDate("date", LocalDate.of(2024, 1, 1))
        .addLong("runId", System.currentTimeMillis())
        .toJobParameters();
```

### Deprecated API Cleanup

Spring Batch 6 removed a number of APIs that were deprecated during the 5.x lifecycle:

- `MapJobRegistry` → use `DefaultJobRegistry` (backed by a `ConcurrentHashMap` internally)
- `MapStepRegistry` → same pattern
- Legacy XML-based configuration support narrowed further — prefer Java config
- `JsrFlowJob` and JSR-352 (Batch for Java EE) support removed entirely

### ExecutionContext Serialization

Spring Batch 6 defaults to `DefaultExecutionContextSerializer` which uses standard Java serialization. If you were using the `Jackson2ExecutionContextStringSerializer` explicitly, verify your configuration still sets it — the auto-configured serializer choice may have changed based on classpath.

```java
@Override
protected ExecutionContextSerializer getExecutionContextSerializer() {
    return new Jackson2ExecutionContextStringSerializer();
}
```

## Configuration Reference

A full `JdbcDefaultBatchConfiguration` override showing all the hooks:

```java
@Configuration
public class FullBatchConfig extends JdbcDefaultBatchConfiguration {

    @Autowired
    private DataSource dataSource;

    @Override
    protected DataSource getDataSource() {
        return dataSource;
    }

    @Override
    protected PlatformTransactionManager getTransactionManager() {
        return new JdbcTransactionManager(dataSource);
    }

    @Override
    protected String getTablePrefix() {
        return "BATCH_";
    }

    @Override
    protected int getMaxVarCharLength() {
        return 2500;  // default 2500 — increase if job params are long
    }

    @Override
    protected Charset getCharset() {
        return StandardCharsets.UTF_8;
    }

    @Override
    protected ExecutionContextSerializer getExecutionContextSerializer() {
        return new Jackson2ExecutionContextStringSerializer();
    }

    @Override
    protected JobKeyGenerator<JobParameters> getJobKeyGenerator() {
        return new DefaultJobKeyGenerator();  // or a custom one
    }
}
```

## Complete Working Example

All code shown in this guide is available as a runnable project at [StevenPG/DemosAndArticleContent][demos-repo]. Clone the repo, run `docker-compose up -d` to start Postgres, and `./gradlew test` to run the full test suite against a live database via Testcontainers.

Workflow diagram:

```text
+-----------------------------------------------------------+
|                      ORDER IMPORT JOB                     |
+-----------------------------------------------------------+
         |
         v
+----------------------------------+
|    Step 1: VALIDATE TASKLET      |
|    - Check file path/exists      |
+----------------------------------+
         |
         | (COMPLETED)
         v
+-----------------------------------------------------------+
|            Step 2: IMPORT & ENRICH (Chunk: 5)             |
|                                                           |
|  [ READER ] ----> [ PROCESSOR ] ----> [ WRITER ]          |
|  CSV Input        Val & Enrich        DB Upsert           |
|                         |                 |               |
|                         | (Error)         | (Success)     |
|                         v                 v               |
|                 +----------------+   +----------------+   |
|                 |  SkipListener  |   |  Orders Table  |   |
|                 | (Error Table)  |   |   (Database)   |   |
|                 +----------------+   +----------------+   |
+-----------------------------------------------------------+
         |
         | (COMPLETED)
         v
+----------------------------------+
|     Step 3: REPORT TASKLET       |
|    - Count rows / Log summary    |
+----------------------------------+
```

### Sample Data

`src/test/resources/test-orders.csv` (13 data rows):

```csv
id,customerId,productCode,amount,orderDate
ORD001,C001,PROD-A,99.99,2024-01-01
ORD002,C002,PROD-B,149.99,2024-01-02
ORD003,C003,PROD-C,49.99,2024-01-03
ORD004,C004,PROD-D,199.99,2024-01-04
ORD005,C005,PROD-E,299.99,2024-01-05
ORD006,C001,PROD-A,79.99,2024-01-06
ORD007,C002,PROD-B,59.99,2024-01-07
ORD008,C003,PROD-C,89.99,2024-01-08
ORD009,C004,PROD-D,119.99,2024-01-09
ORD010,C005,PROD-E,159.99,2024-01-10
ORD011,,PROD-F,39.99,2024-01-11
ORD012,C001,,29.99,2024-01-12
ORD013,C002,PROD-G,0.00,2024-01-13
```

Rows ORD011–ORD013 exercise the fault-tolerance configuration: ORD011 has a blank `customerId`, ORD012 has a blank `productCode`, and ORD013 has a zero amount.

### `importStep` Execution Counts

| Counter | Value | Explanation |
|---|---|---|
| `readCount` | 13 | All 13 data rows read from the CSV |
| `writeCount` | 10 | 10 valid, non-zero-amount orders written |
| `processSkipCount` | 2 | ORD011 (blank `customerId`), ORD012 (blank `productCode`) — `ValidationException` skipped |
| `filterCount` | 1 | ORD013 (`amount = 0.00`) — processor returned `null` |

`FullImportJobTest` and `ImportStepTest` both assert these counts with exact matches.

### Sample Run Output

The `Application` class includes a `CommandLineRunner` that fires the job on startup. If no `filePath` argument is supplied it generates a temporary 10-row demo CSV (valid rows only — no intentional skips). Running `./gradlew bootRun` against a local Postgres instance produces output like this:

```
INFO  c.e.b.listener.JobTimingListener  : [JOB START ] orderImportJob started at 2026-05-03T23:45:54.206307
INFO  o.s.batch.core.step.AbstractStep  : Executing step: [validateStep]
INFO  c.example.batchguide.job.OrderImportJob : [VALIDATE  ] Input file confirmed: /tmp/demo-orders5982228162936361995.csv
INFO  o.s.batch.core.step.AbstractStep  : Step: [validateStep] executed in 17ms
INFO  o.s.batch.core.step.AbstractStep  : Executing step: [importStep]
INFO  o.s.batch.core.step.AbstractStep  : Step: [importStep] executed in 39ms
INFO  o.s.batch.core.step.AbstractStep  : Executing step: [reportStep]
INFO  c.example.batchguide.job.OrderImportJob : [REPORT    ] Run complete — orders written: 10, orders skipped: 0
INFO  o.s.batch.core.step.AbstractStep  : Step: [reportStep] executed in 6ms
INFO  c.e.b.listener.JobTimingListener  : [JOB END   ] orderImportJob finished at 2026-05-03T23:45:54.319738 (elapsed: 113 ms) status=COMPLETED
```

To run against the full test CSV (with intentional skips and a filtered row), pass the file path as an argument:

```
./gradlew bootRun --args='filePath=/path/to/test-orders.csv'
```

[spring-batch-docs]: https://docs.spring.io/spring-batch/reference/
[spring-batch-github]: https://github.com/spring-projects/spring-batch
[spring-batch-migration-guide]: https://github.com/spring-projects/spring-batch/wiki/Spring-Batch-6.0-Migration-Guide
[demos-repo]: https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/spring-batch-6-ultimate-guide
