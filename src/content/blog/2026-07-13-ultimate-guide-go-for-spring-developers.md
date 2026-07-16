---
author: StevenPG
pubDatetime: 2026-07-13T12:00:00.000Z
title: "The Ultimate Guide to Go for Spring Developers"
slug: ultimate-guide-go-for-spring-developers
featured: true
draft: false
ogImage: /assets/default-og-image.png
tags:
  - golang
  - java
  - spring boot
  - oauth2
  - kafka
  - postgres
description: A concern-by-concern translation guide for Spring Boot developers learning Go — the same production order service built twice, mapping DI, REST, validation, JPA, Flyway, OAuth2, Kafka, scheduling, configuration, and observability to their idiomatic Go equivalents.
---

# The Ultimate Guide to Go for Spring Developers

## Table of Contents

[[toc]]

## Introduction

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. And picking up Go as a longtime Spring developer caused me trouble — not because Go is hard, but because every Go tutorial starts from zero. "Here's a hello-world HTTP server" doesn't answer the questions a Spring developer actually has: _where do my beans go? What replaces `@KafkaListener`? How do I do two OAuth2 client-credentials registrations? Who runs Flyway?_

This guide answers those questions directly. Instead of teaching Go from scratch, it **translates** — every building block you already use in a production Spring Boot service, mapped to its idiomatic Go equivalent, with real code on both sides.

And I mean _real_ code. The companion project for this post builds one non-trivial order-processing service **twice**: once as an idiomatic Spring Boot 4 application, and once in idiomatic Go — standard library plus a handful of focused dependencies, no web framework, no ORM. Both services are behaviorally identical. They validate the same requests, return the same RFC 9457 problem responses, run the same schema migrations at startup, validate the same Keycloak JWTs, fetch tokens for the same two downstream APIs, and even **share a Kafka topic**, so an order created in the Spring app can be watched flowing through the Go app's consumer and vice versa.

Everything both services implement:

| Concern           | Feature                                                                  |
|-------------------|--------------------------------------------------------------------------|
| REST API          | `POST/GET /api/orders` with JSON, path/query params                      |
| Validation        | Request bodies validated, structured 400 responses                       |
| Error handling    | RFC 9457 `application/problem+json` everywhere                           |
| Persistence       | Postgres, one row per order                                              |
| Migrations        | Versioned schema migrations run at startup                               |
| Inbound security  | OAuth2 resource server: validate Keycloak JWTs, enforce scopes per route |
| Outbound security | **Two** OAuth2 client-credentials targets (payment + inventory)          |
| Messaging         | Kafka producer on order creation; consumer drives processing             |
| Scheduled work    | Background job counting unfinished orders                                |
| Configuration     | Typed config with defaults                                               |
| Observability     | Health endpoints + Prometheus metrics                                    |

If you've read my [GraalVM native Spring Boot vs Go benchmark](/posts/go-vs-spring-boot-native-benchmark), this is the qualitative companion to that quantitative post. That one measured build time, startup, and throughput. This one answers the question that actually decides whether your team can adopt Go: **how does the code you write every day translate?**

The full project is at [github.com/StevenPG/DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/spring-boot-vs-golang) and is referenced throughout.

## The One Mental Model That Makes Go Click

If you take a single idea from this post, take this one:

> **Spring Boot's `@SpringBootApplication` + component scanning is replaced by Go's `func main()`.** Everything auto-configuration does implicitly — build a datasource, start Kafka listeners, register a JWT decoder, wire beans together — you do _explicitly_ in `main()`. It's longer, but there is no magic, and nothing you didn't write executes.

Here is the entire Spring application class:

```java
@SpringBootApplication
@EnableScheduling
@ConfigurationPropertiesScan
public class OrdersApplication {

    public static void main(String[] args) {
        SpringApplication.run(OrdersApplication.class, args);
    }
}
```

Three annotations. Behind them, Spring builds a `DataSource`, runs Flyway, configures Kafka producer and consumer factories, sets up a JWT decoder from an issuer URI, registers two OAuth2 clients, starts a scheduler thread pool, and wires roughly a dozen beans together by constructor injection — all from `application.yaml` and the classpath.

Now here is the Go equivalent. This is the _whole_ application bootstrap, and I'd encourage you to actually read it, because it's the skeleton every section of this guide hangs off of:

```go
func run(log *slog.Logger) error {
    // Cancelled on SIGINT/SIGTERM; everything long-running hangs off this
    // context, so cancellation is the shutdown signal for the whole app.
    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer stop()

    cfg, err := config.Load()
    if err != nil {
        return err
    }

    // --- Database: pool + migrations (Spring: DataSource + Flyway) ---
    pool, err := db.Connect(ctx, cfg.DatabaseURL)
    if err != nil {
        return err
    }
    defer pool.Close()

    if err := db.Migrate(cfg.DatabaseURL, migrations); err != nil {
        return err
    }

    // --- Inbound auth (Spring: oauth2ResourceServer + issuer-uri) ---
    verifier, err := auth.NewVerifier(ctx, cfg.JWKSURL(), cfg.OAuthIssuer)
    if err != nil {
        return err
    }

    // --- Outbound OAuth2 clients (Spring: two client registrations) ---
    payment := clients.NewPaymentClient(ctx, cfg.PaymentBaseURL,
        cfg.Payment.ClientID, cfg.Payment.ClientSecret, cfg.TokenURL(), cfg.Payment.Scopes)
    inventory := clients.NewInventoryClient(ctx, cfg.InventoryBaseURL,
        cfg.Inventory.ClientID, cfg.Inventory.ClientSecret, cfg.TokenURL(), cfg.Inventory.Scopes)

    // --- Kafka + domain wiring (Spring: component scan does this) ---
    producer := messaging.NewProducer(cfg.KafkaBrokers, cfg.OrdersTopic, log)
    defer producer.Close()

    repo := orders.NewRepository(pool)
    service := orders.NewService(repo, payment, inventory, producer, log)

    consumer := messaging.NewConsumer(cfg.KafkaBrokers, cfg.OrdersTopic, cfg.ConsumerGroup, service, log)
    defer consumer.Close()
    go consumer.Run(ctx)

    // --- Scheduled job (Spring: @Scheduled) ---
    reporter := jobs.NewPendingOrdersReporter(repo, cfg.ReportInterval, log)
    go reporter.Run(ctx)

    // --- HTTP server (Spring: embedded Tomcat) ---
    server := &http.Server{
        Addr:              ":" + cfg.Port,
        Handler:           httpapi.NewMux(service, verifier, pool, log),
        ReadHeaderTimeout: 5 * time.Second,
    }

    errCh := make(chan error, 1)
    go func() {
        log.Info("http server listening", "addr", server.Addr)
        if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
            errCh <- err
        }
    }()

    select {
    case err := <-errCh:
        return fmt.Errorf("http server: %w", err)
    case <-ctx.Done():
    }

    // Graceful shutdown: stop accepting connections, give in-flight requests
    // ten seconds to finish. Deferred Closes handle Kafka and the pool.
    log.Info("shutting down")
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()
    return server.Shutdown(shutdownCtx)
}
```

That's it. That's the framework. Every arrow in your mental Spring context diagram is a line of ordinary code here, and the dependency graph is literally the order of statements. When a Spring developer asks "but where does X happen in Go?", the answer is almost always: _on a line in `main()` that you can click through_.

The rest of this guide walks that skeleton concern by concern.

## The Toolchain, in Spring Terms

Before the code, a 60-second mapping of the build ecosystem, because it's the first thing that feels alien:

| You know                 | Go equivalent                   | Notes                                                      |
| ------------------------ | ------------------------------- | ---------------------------------------------------------- |
| Gradle/Maven             | `go` command                    | Build tool ships with the language; there are no plugins   |
| `build.gradle.kts`       | `go.mod`                        | Declares module path + dependencies                        |
| Version catalogs / BOMs  | `go.sum`                        | Checksummed lockfile, generated                            |
| `./gradlew bootRun`      | `go run .`                      | No wrapper needed — the toolchain is versioned in `go.mod` |
| `./gradlew build`        | `go build`                      | Produces a single static binary, typically in seconds      |
| JUnit + `./gradlew test` | `go test ./...`                 | Test runner is built in                                    |
| Checkstyle/Spotless      | `gofmt` / `go vet`              | Formatting is non-negotiable and built in                  |
| Maven Central            | Module proxy (proxy.golang.org) | Dependencies are just Git repos, verified by checksum      |

The dependency list for the entire Go service — everything that isn't standard library — fits in one glance:

```go
require (
    github.com/MicahParks/keyfunc/v3 v3.8.0        // JWKS fetching + refresh
    github.com/golang-jwt/jwt/v5 v5.3.1            // JWT validation
    github.com/golang-migrate/migrate/v4 v4.19.1   // Flyway equivalent
    github.com/google/uuid v1.6.0
    github.com/jackc/pgx/v5 v5.10.0                // Postgres driver + pool
    github.com/prometheus/client_golang v1.23.2    // Micrometer equivalent
    github.com/segmentio/kafka-go v0.4.51          // Kafka client
    golang.org/x/oauth2 v0.36.0                    // client-credentials flow
)
```

Compare that with the Spring side's starters (`webmvc`, `validation`, `data-jpa`, `flyway`, `oauth2-resource-server`, `oauth2-client`, `spring-kafka`, `actuator`) — the _categories_ line up almost one to one. The difference is that a Go dependency is a library you call, not a starter that configures itself.

## 1. Dependency Injection and Wiring

**Spring:** component scanning discovers `@Service`, `@Component`, `@RestController`, and `@Repository` beans and injects them through constructors. You never call `new`:

```java
@Service
public class OrderService {

    public OrderService(OrderRepository repository,
                        PaymentClient paymentClient,
                        InventoryClient inventoryClient,
                        OrderEventPublisher eventPublisher) {
        // ...
    }
}
```

**Go:** there is no container. You call the constructors yourself in `main()` and pass dependencies in. You already saw the wiring in the skeleton above:

```go
repo := orders.NewRepository(pool)
service := orders.NewService(repo, payment, inventory, producer, log)
consumer := messaging.NewConsumer(cfg.KafkaBrokers, cfg.OrdersTopic, cfg.ConsumerGroup, service, log)
```

The part that actually matters — and the thing that makes Go testable without Mockito or `@MockBean` — is _where the interfaces live_. In Spring, the implementation usually defines the contract. In Go, **interfaces are declared by the consumer**, and they're small:

```go
// The service depends on small interfaces declared *here*, on the consumer
// side. Anything satisfying them can be injected — including test fakes,
// with no mocking framework.
type PaymentCharger interface {
    Charge(ctx context.Context, orderID uuid.UUID, amountCents int64) (paymentID string, err error)
}

type InventoryReserver interface {
    Reserve(ctx context.Context, orderID uuid.UUID, item string, quantity int) error
}

type EventPublisher interface {
    PublishOrderCreated(ctx context.Context, orderID uuid.UUID) error
}

type Service struct {
    repo      *Repository
    payment   PaymentCharger
    inventory InventoryReserver
    events    EventPublisher
    log       *slog.Logger
}
```

The concrete `PaymentClient` never says `implements PaymentCharger` — Go interfaces are satisfied structurally. If it has the right method, it fits. Your test passes a three-line fake struct instead of a mock, and there's no proxying, no context caching, and no `@DirtiesContext` folklore.

One honest note: at this project's size, manual wiring is genuinely pleasant. At 200 components it becomes a very long `main()`, which is why Google maintains [Wire](https://github.com/google/wire) (compile-time DI codegen) and Uber maintains [fx](https://github.com/uber-go/fx) (a runtime container). Most Go teams still just write the function.

## 2. The REST API

**Spring:** `@RestController` + mapping annotations. Binding, deserialization, and serialization are automatic:

```java
@RestController
@RequestMapping("/api/orders")
public class OrderController {

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public OrderResponse create(@Valid @RequestBody CreateOrderRequest request) {
        var order = orderService.createOrder(
                request.customerEmail(), request.item(), request.quantity(), request.totalCents());
        return OrderResponse.from(order);
    }

    @GetMapping("/{id}")
    public OrderResponse get(@PathVariable UUID id) {
        return OrderResponse.from(orderService.getOrder(id));
    }

    @GetMapping
    public List<OrderResponse> list(@RequestParam(required = false) OrderStatus status) {
        return orderService.listOrders(status).stream().map(OrderResponse::from).toList();
    }
}
```

**Go:** the standard library's `net/http`, and nothing else. This surprises most Spring developers: since Go 1.22, the built-in `ServeMux` supports method-and-path patterns with wildcards, so for a typical JSON API **you don't need Gin, Echo, or Chi at all**. The route table is plain code:

```go
mux := http.NewServeMux()

mux.Handle("POST /api/orders", verifier.RequireScope("orders:write", http.HandlerFunc(h.create)))
mux.Handle("GET /api/orders/{id}", verifier.RequireScope("orders:read", http.HandlerFunc(h.get)))
mux.Handle("GET /api/orders", verifier.RequireScope("orders:read", http.HandlerFunc(h.list)))
```

Notice that the route table doubles as the security table — more on that in the OAuth2 section. A handler does explicitly what `@RequestBody`/`@ResponseStatus` do implicitly:

```go
func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
    var req orders.CreateOrderRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        writeProblem(w, http.StatusBadRequest, "malformed JSON body", nil)
        return
    }
    if errs := req.Validate(); len(errs) > 0 {
        writeProblem(w, http.StatusBadRequest, "Request validation failed", errs)
        return
    }

    order, err := h.service.Create(r.Context(), req)
    if err != nil {
        h.serverError(w, err)
        return
    }
    writeJSON(w, http.StatusCreated, order)
}
```

The annotation-to-code cheat sheet:

| Spring                         | Go stdlib                                         |
| ------------------------------ | ------------------------------------------------- |
| `@PostMapping`                 | `mux.Handle("POST /api/orders", ...)`             |
| `@PathVariable UUID id`        | `uuid.Parse(r.PathValue("id"))`                   |
| `@RequestParam`                | `r.URL.Query().Get("status")`                     |
| `@RequestBody`                 | `json.NewDecoder(r.Body).Decode(&req)`            |
| `@ResponseStatus(CREATED)`     | `writeJSON(w, http.StatusCreated, order)`         |
| `HandlerInterceptor` / filters | Middleware: a function wrapping an `http.Handler` |

The pattern of middleware — `func(next http.Handler) http.Handler` — is the single most important Go web idiom to internalize. It's the servlet filter chain, except each link is a function you wrote and can step through.

## 3. Validation

**Spring:** declare constraints on the DTO, trigger with `@Valid`, and violations arrive as a `MethodArgumentNotValidException`:

```java
public record CreateOrderRequest(
        @NotBlank @Email String customerEmail,
        @NotBlank String item,
        @Min(1) @Max(1000) int quantity,
        @Positive long totalCents) {
}
```

**Go:** there's no annotation processor, so validation is a method you write and call:

```go
func (r CreateOrderRequest) Validate() map[string]string {
    errs := map[string]string{}
    if r.CustomerEmail == "" {
        errs["customerEmail"] = "must not be blank"
    } else if _, err := mail.ParseAddress(r.CustomerEmail); err != nil {
        errs["customerEmail"] = "must be a well-formed email address"
    }
    if r.Item == "" {
        errs["item"] = "must not be blank"
    }
    if r.Quantity < 1 || r.Quantity > 1000 {
        errs["quantity"] = "must be between 1 and 1000"
    }
    if r.TotalCents <= 0 {
        errs["totalCents"] = "must be greater than 0"
    }
    return errs
}
```

Yes, it's more lines. It's also grep-able, debuggable, and impossible to silently skip by forgetting `@Valid` — an error I'd bet every reader of this blog has shipped at least once.

If your team wants declarative validation, [go-playground/validator](https://github.com/go-playground/validator) gives you struct tags (`validate:"required,email"`) that feel very close to Bean Validation. The demo deliberately uses the dependency-free version so the contrast stays visible.

## 4. Error Handling

**Spring:** a `@RestControllerAdvice` centralizes exception mapping for every controller, and `ProblemDetail` (built into Spring 6+) produces RFC 9457 responses:

```java
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(OrderNotFoundException.class)
    public ProblemDetail handleNotFound(OrderNotFoundException e) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, e.getMessage());
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ProblemDetail handleValidation(MethodArgumentNotValidException e) {
        Map<String, String> errors = new LinkedHashMap<>();
        e.getBindingResult().getFieldErrors()
                .forEach(fe -> errors.put(fe.getField(), fe.getDefaultMessage()));
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(
                HttpStatus.BAD_REQUEST, "Request validation failed");
        problem.setProperty("errors", errors);
        return problem;
    }
}
```

**Go:** two things change at once here, and it's worth separating them.

First, **Go has no exceptions**. Functions return errors as values, and the caller checks them. The repository defines a sentinel error, and the handler matches on it with `errors.Is`:

```go
// In the repository package — the "Optional.empty()" of this app:
var ErrNotFound = errors.New("order not found")

// In the handler:
order, err := h.service.Get(r.Context(), id)
if errors.Is(err, orders.ErrNotFound) {
    writeProblem(w, http.StatusNotFound, "Order "+id.String()+" not found", nil)
    return
}
if err != nil {
    h.serverError(w, err)
    return
}
writeJSON(w, http.StatusOK, order)
```

Second, **there's no global advice** — each handler maps its own errors, with a shared helper producing the identical `application/problem+json` shape:

```go
func writeProblem(w http.ResponseWriter, status int, detail string, fieldErrors map[string]string) {
    body := map[string]any{
        "status": status,
        "title":  http.StatusText(status),
        "detail": detail,
    }
    if len(fieldErrors) > 0 {
        body["errors"] = fieldErrors
    }
    w.Header().Set("Content-Type", "application/problem+json")
    w.WriteHeader(status)
    _ = json.NewEncoder(w).Encode(body)
}
```

The trade-off in one sentence: Spring's advice is DRY but action-at-a-distance (an exception thrown five layers down materializes as a 404 by non-local magic); Go's is repetitive but local and obvious. The `if err != nil` blocks are the part of Go that Spring developers complain about in week one and stop noticing by week four — they read as noise until you're debugging, at which point every error path being visible becomes the feature.

## 5. Persistence

This is the biggest philosophical gap of the thirteen.

**Spring:** Spring Data JPA. Extend an interface, get CRUD for free, and derive queries from method names:

```java
public interface OrderRepository extends JpaRepository<Order, UUID> {

    List<Order> findByStatusOrderByCreatedAtDesc(OrderStatus status);

    long countByStatus(OrderStatus status);
}
```

You write zero SQL. Hibernate maps the `@Entity`, generates the queries, dirty-checks managed entities, and flushes changes inside `@Transactional` boundaries.

**Go:** the mainstream Go instinct is **no ORM**. The repository is a struct holding a `pgxpool.Pool`, and every query is SQL you wrote:

```go
type Repository struct {
    pool *pgxpool.Pool
}

const orderColumns = `id, customer_email, item, quantity, total_cents, status,
    payment_id, failure_reason, created_at, updated_at`

func (r *Repository) GetByID(ctx context.Context, id uuid.UUID) (Order, error) {
    o, err := scanOrder(r.pool.QueryRow(ctx,
        `SELECT `+orderColumns+` FROM orders WHERE id = $1`, id))
    if errors.Is(err, pgx.ErrNoRows) {
        return Order{}, ErrNotFound
    }
    if err != nil {
        return Order{}, fmt.Errorf("get order: %w", err)
    }
    return o, nil
}

// The equivalent of findByStatusOrderByCreatedAtDesc — written out:
func (r *Repository) List(ctx context.Context, status *Status) ([]Order, error) {
    query := `SELECT ` + orderColumns + ` FROM orders`
    args := []any{}
    if status != nil {
        query += ` WHERE status = $1 ORDER BY created_at DESC`
        args = append(args, *status)
    }

    rows, err := r.pool.Query(ctx, query, args...)
    if err != nil {
        return nil, fmt.Errorf("list orders: %w", err)
    }
    defer rows.Close()

    result := []Order{}
    for rows.Next() {
        o, err := scanOrder(rows)
        if err != nil {
            return nil, fmt.Errorf("scan order: %w", err)
        }
        result = append(result, o)
    }
    return result, rows.Err()
}
```

And the entity? It's just a struct. No proxy, no lazy loading, no managed/detached lifecycle:

```go
type Order struct {
    ID            uuid.UUID `json:"id"`
    CustomerEmail string    `json:"customerEmail"`
    Item          string    `json:"item"`
    Quantity      int       `json:"quantity"`
    TotalCents    int64     `json:"totalCents"`
    Status        Status    `json:"status"`
    PaymentID     *string   `json:"paymentId"`
    FailureReason *string   `json:"failureReason"`
    CreatedAt     time.Time `json:"createdAt"`
    UpdatedAt     time.Time `json:"updatedAt"`
}
```

Note the `context.Context` threaded through every call — that's Go's cancellation and deadline mechanism, roughly the machinery Spring hides inside its transaction and request scopes. It looks like ceremony; it's actually the reason a cancelled HTTP request can abort its in-flight database query.

Go _does_ have ORMs ([GORM](https://gorm.io), [ent](https://entgo.io)) and, more idiomatically, [sqlc](https://sqlc.dev), which generates type-safe Go from SQL you write — in my opinion the tool closest to the Go philosophy: SQL stays visible, boilerplate gets generated.

### Transactions

Spring's `@Transactional` wraps the method in a transaction via proxy. Go has no proxies, so you have two options, and the demo shows the more interesting one: **design state transitions as single atomic statements**. When a Kafka event arrives, the service claims the order with a conditional `UPDATE` that doubles as an idempotency guard against duplicate deliveries:

```go
// ClaimForProcessing atomically flips PENDING -> PROCESSING. The conditional
// UPDATE doubles as an idempotency guard for duplicate Kafka deliveries; it
// returns false when the order doesn't exist or was already claimed.
func (r *Repository) ClaimForProcessing(ctx context.Context, id uuid.UUID) (bool, error) {
    tag, err := r.pool.Exec(ctx, `
        UPDATE orders SET status = $1, updated_at = $2
        WHERE id = $3 AND status = $4`,
        StatusProcessing, time.Now().UTC(), id, StatusPending)
    if err != nil {
        return false, fmt.Errorf("claim order: %w", err)
    }
    return tag.RowsAffected() == 1, nil
}
```

For genuinely multi-statement transactions, it's explicit: `tx, _ := pool.Begin(ctx)`, do the work, `tx.Commit(ctx)`, with a `defer tx.Rollback(ctx)` as the safety net. No proxy semantics, no "why didn't my `@Transactional` fire on a self-invocation" — the answer to every transaction question is on the screen.

## 6. Database Migrations

**Spring:** put Flyway on the classpath, drop `V1__create_orders.sql` into `db/migration/`, and migrations run at startup, tracked in `flyway_schema_history`. It's one of Spring Boot's best pieces of auto-configuration.

One Boot 4 trap worth flagging: `org.flywaydb:flyway-core` alone is no longer enough. Boot 4 split Flyway's auto-configuration out into its own starter, so without `org.springframework.boot:spring-boot-starter-flyway` on the classpath, migrations silently don't run at startup — no error, just an empty schema. It's the kind of "why does this table not exist" bug that costs an afternoon.

**Go:** [golang-migrate](https://github.com/golang-migrate/migrate) is the direct equivalent, with paired up/down files (`0001_create_orders.up.sql` / `.down.sql`) tracked in a `schema_migrations` table. The interesting Go-specific twist is `//go:embed`, which compiles the SQL files _into the binary_:

```go
//go:embed migrations/*.sql
var migrations embed.FS
```

```go
// golang-migrate is the community's Flyway. It records applied versions in
// the schema_migrations table.
func Migrate(databaseURL string, migrations embed.FS) error {
    source, err := iofs.New(migrations, "migrations")
    if err != nil {
        return fmt.Errorf("load embedded migrations: %w", err)
    }

    url := strings.Replace(databaseURL, "postgres://", "pgx5://", 1)
    m, err := migrate.NewWithSourceInstance("iofs", source, url)
    if err != nil {
        return fmt.Errorf("init migrate: %w", err)
    }
    defer m.Close()

    if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
        return fmt.Errorf("apply migrations: %w", err)
    }
    return nil
}
```

There is no classpath in Go — `go:embed` is what replaces "resources on the classpath" for migrations, templates, and static files alike. The deployable is one self-contained executable, schema included.

## 7. Inbound Security: OAuth2 Resource Server

Longtime readers know [Spring OAuth2 is a recurring topic here](/posts/ultimate-guide-spring-web-clients-oauth2), so this section and the next are the heart of the guide.

**Spring:** one property turns the app into a resource server:

```yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: http://localhost:8090/realms/demo
```

Spring fetches the issuer's JWKS, validates signature/issuer/expiry on every request, and exposes each entry of the token's `scope` claim as a `SCOPE_*` authority for the filter chain:

```java
@Bean
SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
    http
            .csrf(csrf -> csrf.disable())
            .sessionManagement(session ->
                    session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(auth -> auth
                    .requestMatchers("/actuator/health/**", "/actuator/prometheus").permitAll()
                    .requestMatchers(HttpMethod.GET, "/api/orders/**")
                    .hasAuthority("SCOPE_orders:read")
                    .requestMatchers(HttpMethod.POST, "/api/orders/**")
                    .hasAuthority("SCOPE_orders:write")
                    .anyRequest().authenticated())
            .oauth2ResourceServer(oauth2 -> oauth2.jwt(Customizer.withDefaults()));
    return http.build();
}
```

**Go:** you build the slice of Spring Security you need — and it turns out that slice is about 100 lines. Two libraries do the heavy lifting: `keyfunc` fetches and background-refreshes the JWKS (what `issuer-uri` sets up), and `golang-jwt` validates tokens. The rest is a middleware:

```go
// RequireScope wraps a handler with authentication + a scope check, the
// counterpart of .requestMatchers(...).hasAuthority("SCOPE_x") in Spring.
func (v *Verifier) RequireScope(scope string, next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        tokenString, ok := bearerToken(r)
        if !ok {
            unauthorized(w, "missing bearer token")
            return
        }

        token, err := jwt.Parse(tokenString, v.keys.Keyfunc,
            jwt.WithIssuer(v.issuer),
            jwt.WithExpirationRequired(),
            jwt.WithValidMethods([]string{"RS256"}))
        if err != nil {
            unauthorized(w, "invalid token: "+err.Error())
            return
        }

        claims, ok := token.Claims.(jwt.MapClaims)
        if !ok || !hasScope(claims, scope) {
            forbidden(w, "token lacks required scope "+scope)
            return
        }

        next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), contextKey{}, claims)))
    })
}

// hasScope checks the OAuth2 "scope" claim (space-delimited, per Keycloak).
func hasScope(claims jwt.MapClaims, scope string) bool {
    raw, _ := claims["scope"].(string)
    return slices.Contains(strings.Fields(raw), scope)
}
```

And the route-to-scope mapping lives directly in the mux setup — the same job as the `authorizeHttpRequests` block, colocated with the routes themselves:

```go
mux.Handle("POST /api/orders", verifier.RequireScope("orders:write", http.HandlerFunc(h.create)))
mux.Handle("GET /api/orders/{id}", verifier.RequireScope("orders:read", http.HandlerFunc(h.get)))
```

A word of caution, because it matters: **the Spring version encodes years of hardened defaults, and the Go version is code you now own.** `jwt.WithValidMethods` (pinning RS256 to block algorithm-confusion attacks), `jwt.WithExpirationRequired`, issuer checking — Spring does all of that whether or not you knew to ask. In Go, forgetting one of those options compiles fine. This is the clearest instance of the guide's theme: Go trades framework leverage for visibility, and visibility includes the security-critical parts.

## 8. Outbound Security: Two OAuth2 Client-Credentials Targets

The demo service calls two downstream APIs — payment and inventory — each with its **own** client registration, credentials, and scope. I chose this deliberately, because single-client examples hide the plumbing, and [multi-registration setups are where Spring's OAuth2 client support gets subtle](/posts/easy-spring-rest-client-with-oauth2).

**Spring:** declare both registrations in YAML:

```yaml
spring:
  security:
    oauth2:
      client:
        provider:
          keycloak:
            token-uri: http://localhost:8090/realms/demo/protocol/openid-connect/token
        registration:
          payment:
            provider: keycloak
            client-id: payment-client
            client-secret: payment-client-secret
            authorization-grant-type: client_credentials
            scope: payments:charge
          inventory:
            provider: keycloak
            client-id: inventory-client
            client-secret: inventory-client-secret
            authorization-grant-type: client_credentials
            scope: inventory:reserve
```

Then wire an interceptor per registration onto a `RestClient`:

```java
private RestClient oauth2RestClient(RestClient.Builder builder,
                                    OAuth2AuthorizedClientManager authorizedClientManager,
                                    String registrationId,
                                    String baseUrl) {
    var interceptor = new OAuth2ClientHttpRequestInterceptor(authorizedClientManager);
    interceptor.setClientRegistrationIdResolver(request -> registrationId);
    return builder.clone()
            .baseUrl(baseUrl)
            .requestInterceptor(interceptor)
            .build();
}
```

One more Boot 4 starter split before the real landmine: `spring-boot-starter-oauth2-client` no longer pulls in `RestClient.Builder` auto-configuration — that moved out of the web starter into its own `spring-boot-starter-restclient`. Without it, the `RestClient.Builder` this section wires below simply isn't there to inject.

There's one production landmine the demo documents, and if you take nothing else from the Spring side, take this: **the default `OAuth2AuthorizedClientManager` is bound to the servlet request.** This service acquires tokens from Kafka listener threads, where there is no request in scope — with the default manager, that fails. The fix is the service-based manager:

```java
/**
 * The default OAuth2AuthorizedClientManager is bound to the servlet
 * request. Order processing runs on Kafka listener threads with no request
 * in scope, so we use the service-based manager, which works anywhere.
 */
@Bean
OAuth2AuthorizedClientManager authorizedClientManager(
        ClientRegistrationRepository clientRegistrationRepository,
        OAuth2AuthorizedClientService authorizedClientService) {
    var manager = new AuthorizedClientServiceOAuth2AuthorizedClientManager(
            clientRegistrationRepository, authorizedClientService);
    manager.setAuthorizedClientProvider(
            OAuth2AuthorizedClientProviderBuilder.builder().clientCredentials().build());
    return manager;
}
```

**Go:** this is the section where Go developers get to feel smug, because the standard extended library nails it. `golang.org/x/oauth2/clientcredentials` does exactly what the authorized client manager does — fetch a token, cache it, refresh on expiry — and hands you back a plain `*http.Client` that injects the Bearer header transparently:

```go
func oauth2HTTPClient(ctx context.Context, clientID, clientSecret, tokenURL string, scopes []string) *http.Client {
    cfg := clientcredentials.Config{
        ClientID:     clientID,
        ClientSecret: clientSecret,
        TokenURL:     tokenURL,
        Scopes:       scopes,
    }
    client := cfg.Client(ctx)
    client.Timeout = 10 * time.Second
    return client
}
```

Two registrations means calling it twice. Each downstream client wraps its own token-injecting `http.Client`, so the credentials and scopes stay independent:

```go
type PaymentClient struct {
    baseURL string
    http    *http.Client
}

func NewPaymentClient(ctx context.Context, baseURL, clientID, clientSecret, tokenURL string, scopes []string) *PaymentClient {
    return &PaymentClient{
        baseURL: baseURL,
        http:    oauth2HTTPClient(ctx, clientID, clientSecret, tokenURL, scopes),
    }
}

func (c *PaymentClient) Charge(ctx context.Context, orderID uuid.UUID, amountCents int64) (string, error) {
    var result struct {
        PaymentID string `json:"paymentId"`
        Status    string `json:"status"`
    }
    err := postJSON(ctx, c.http, c.baseURL+"/payments", map[string]any{
        "orderId":     orderID.String(),
        "amountCents": amountCents,
    }, &result)
    if err != nil {
        return "", err
    }
    return result.PaymentID, nil
}
```

There's no request-scope caveat because there's no request scope — a Go `http.Client` works identically whether it's called from an HTTP handler, a Kafka consumer goroutine, or a scheduled job. The entire token lifecycle for both stacks does the same thing; the Go one just fits in a package you can read in one sitting.

## 9. Messaging with Kafka

**Spring:** producing is `KafkaTemplate`, consuming is `@KafkaListener`, and the framework owns the poll loop, JSON (de)serialization, offset commits, and rebalancing.

Same Boot 4 trap as Flyway, different starter: `org.springframework.kafka:spring-kafka` gives you the library, not the auto-configuration for `KafkaTemplate` and the listener container. That moved to `org.springframework.boot:spring-boot-starter-kafka`. Miss it and beans you'd expect Boot to wire — the template, the listener container factory — just aren't there.

A second, subtler gotcha shows up once your event has a timestamp. The auto-configured `JsonSerializer`/`JsonDeserializer` build their own plain `ObjectMapper`, which doesn't inherit Spring's Jackson auto-configuration — so a `java.time.Instant` field on `OrderEvent` fails to serialize until you register `JavaTimeModule` on that Kafka-specific mapper yourself. And because the Go consumer unmarshals that same field into a `time.Time`, which only parses RFC 3339 strings, you also have to disable `WRITE_DATES_AS_TIMESTAMPS` so it's written as an ISO-8601 string instead of a raw epoch number. Two ecosystems, one topic, and the JSON shape has to satisfy both — it's the cross-language tax for sharing a topic at all.

```java
public void publishOrderCreated(UUID orderId) {
    OrderEvent event = OrderEvent.created(orderId, SOURCE);
    kafkaTemplate.send(properties.ordersTopic(), orderId.toString(), event);
}

@KafkaListener(topics = "${app.kafka.orders-topic}")
public void onOrderEvent(OrderEvent event) {
    log.info("Received {} for order {} from {}", event.type(), event.orderId(), event.source());
    if (OrderEvent.ORDER_CREATED.equals(event.type())) {
        orderService.processOrder(event.orderId());
    }
}
```

**Go:** with [segmentio/kafka-go](https://github.com/segmentio/kafka-go), producing looks about the same. Consuming is the revelation: **you own the poll loop.** The code `@KafkaListener` generates behind the scenes is right there:

```go
func (c *Consumer) Run(ctx context.Context) {
    c.log.Info("kafka consumer started")
    for {
        msg, err := c.reader.ReadMessage(ctx) // blocks; commits offsets for the group
        if err != nil {
            if errors.Is(err, context.Canceled) || errors.Is(err, kafka.ErrGroupClosed) {
                c.log.Info("kafka consumer stopped")
                return
            }
            c.log.Error("kafka read failed", "err", err)
            continue
        }

        var event OrderEvent
        if err := json.Unmarshal(msg.Value, &event); err != nil {
            // A poison message: log and move on rather than retry forever.
            c.log.Error("skipping malformed event", "offset", msg.Offset, "err", err)
            continue
        }

        if event.Type == EventOrderCreated {
            if err := c.processor.Process(ctx, event.OrderID); err != nil {
                c.log.Error("failed to process order", "orderId", event.OrderID, "err", err)
            }
        }
    }
}
```

Started from `main()` with two words: `go consumer.Run(ctx)`. That `go` keyword is Spring's entire listener-container thread machinery. Goroutines are cheap enough (kilobytes of stack) that "spawn a loop per concern" is the design idiom, not a resource decision — the closest JVM analogue is virtual threads, except goroutines have been Go's only concurrency primitive since day one, so every library assumes them.

Because both services share the `order-events` topic with distinct consumer groups, each gets its own copy of every event, and an order created in the Spring app is visible to the Go consumer and vice versa. One interop detail worth stealing for any Java-and-Go-share-a-topic situation: Spring's `JsonSerializer` stamps a `__TypeId__` header on every message, and its deserializer prefers that header by default. The demo's Spring config turns that off so the Go producer's plain JSON deserializes cleanly:

```yaml
spring:
  kafka:
    consumer:
      properties:
        spring.json.value.default.type: com.example.orders.messaging.OrderEvent
        # The Go producer doesn't add Spring's __TypeId__ header.
        spring.json.use.type.headers: false
```

## 10. Scheduled Work

**Spring:** `@EnableScheduling` plus one annotation; the framework owns the scheduler pool:

```java
@Scheduled(fixedDelayString = "${app.reporting.interval:30s}")
public void reportPendingOrders() {
    long pending = repository.countByStatus(OrderStatus.PENDING)
            + repository.countByStatus(OrderStatus.PROCESSING);
    pendingCount.set(pending);
    log.info("Pending/processing orders: {}", pending);
}
```

**Go:** a goroutine and a `time.Ticker`. The scheduling, the loop, and — crucially — the shutdown are all in the same ten lines:

```go
func (r *PendingOrdersReporter) Run(ctx context.Context) {
    ticker := time.NewTicker(r.interval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done(): // graceful shutdown
            return
        case <-ticker.C:
            count, err := r.repo.CountUnfinished(ctx)
            if err != nil {
                r.log.Error("failed to count pending orders", "err", err)
                continue
            }
            pendingOrders.Set(float64(count))
            r.log.Info("pending/processing orders", "count", count)
        }
    }
}
```

The `select` statement is Go's control-flow primitive for "wait on whichever of these channels fires first" — here it means every tick also checks whether the app is shutting down. Ever wondered exactly when your `@Scheduled` method stops firing during shutdown, or had a scheduled task keep a context alive? In Go that question has a one-line answer you wrote yourself. (For cron _expressions_ rather than fixed intervals, [robfig/cron](https://github.com/robfig/cron) is the standard pick.)

## 11. Configuration

**Spring:** `application.yaml` with `@ConfigurationProperties` records — typed, validated at startup, with profiles and relaxed binding:

```java
@ConfigurationProperties(prefix = "app.downstream")
public record DownstreamProperties(Endpoint payment, Endpoint inventory) {

    public record Endpoint(String baseUrl) {
    }
}
```

**Go:** a plain struct populated from environment variables, loaded once in `main()` and passed to whatever needs it:

```go
func Load() (Config, error) {
    interval, err := time.ParseDuration(getenv("REPORT_INTERVAL", "30s"))
    if err != nil {
        return Config{}, fmt.Errorf("parse REPORT_INTERVAL: %w", err)
    }

    return Config{
        Port:        getenv("PORT", "8081"),
        DatabaseURL: getenv("DATABASE_URL", "postgres://orders:orders@localhost:5432/orders_go"),

        KafkaBrokers:  strings.Split(getenv("KAFKA_BROKERS", "localhost:9092"), ","),
        OrdersTopic:   getenv("ORDERS_TOPIC", "order-events"),
        ConsumerGroup: getenv("KAFKA_GROUP_ID", "go-order-service"),

        OAuthIssuer: getenv("OAUTH_ISSUER", "http://localhost:8090/realms/demo"),
        // ... payment/inventory client credentials, same pattern ...
        ReportInterval: interval,
    }, nil
}

func getenv(key, fallback string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return fallback
}
```

No profiles, no relaxed binding, no `application-{profile}.yaml` resolution order to memorize — and also none of the flexibility those give you. Environment-variable-only configuration happens to be exactly what containerized deployment wants (it _is_ the [twelve-factor](https://12factor.net/config) recommendation), which is a big part of why the Go community never felt the need for more. When teams do want file-based config with layering, [Viper](https://github.com/spf13/viper) or [koanf](https://github.com/knadh/koanf) are the go-tos.

## 12. Observability

**Spring:** add `spring-boot-starter-actuator` and the Micrometer Prometheus registry, and you get `/actuator/health`, `/actuator/metrics`, and `/actuator/prometheus` — plus dozens of built-in metrics — for free. (If you want the full tour, I wrote an [entire guide on Actuator](/posts/ultimate-guide-spring-boot-actuator).)

**Go:** you assemble the same surface from parts, and it's less work than you'd guess:

```go
// Liveness, readiness (with a real DB ping), and Prometheus metrics.
mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
    writeJSON(w, http.StatusOK, map[string]string{"status": "UP"})
})
mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
    if err := pool.Ping(r.Context()); err != nil {
        writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "DOWN", "db": err.Error()})
        return
    }
    writeJSON(w, http.StatusOK, map[string]string{"status": "UP", "db": "UP"})
})
mux.Handle("GET /metrics", promhttp.Handler())
```

Custom metrics use the Prometheus client library the way you'd use a `MeterRegistry`:

```go
var pendingOrders = promauto.NewGauge(prometheus.GaugeOpts{
    Name: "orders_pending",
    Help: "Orders not yet completed or failed",
})

// in the scheduled reporter:
pendingOrders.Set(float64(count))
```

Both services expose the same `orders_pending` gauge, scrapable side by side:

```bash
curl -s localhost:8080/actuator/prometheus | grep orders_pending   # Spring
curl -s localhost:8081/metrics             | grep orders_pending   # Go
```

The honest gap: Actuator's _built-in_ depth (connection pool stats, JVM internals, `/actuator/env`, ~everything) has no free Go equivalent — the Prometheus client gives you Go runtime and process metrics out of the box, and the rest you add when you need it. For distributed tracing both ecosystems have converged on OpenTelemetry, so that story is nearly identical.

## 13. Lifecycle and Graceful Shutdown

**Spring:** the container manages startup ordering and, with `server.shutdown=graceful`, drains in-flight requests on SIGTERM. Mostly invisible — which is wonderful until you need to reason about it during a Kubernetes rollout.

**Go:** you own the lifecycle, and this is where Go's explicitness pays off most. Three pieces from the `run()` function you read at the top:

```go
// 1. Signals become context cancellation — the app-wide shutdown broadcast:
ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
defer stop()

// 2. Every long-running component hangs off ctx:
go consumer.Run(ctx)
go reporter.Run(ctx)

// 3. On cancellation: drain HTTP with a deadline; defers close the rest:
<-ctx.Done()
shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
defer cancel()
return server.Shutdown(shutdownCtx)
```

SIGTERM cancels the context; the Kafka consumer's blocking `ReadMessage` returns, the reporter's `select` hits `ctx.Done()`, the HTTP server drains in-flight requests with a ten-second budget, and the deferred `Close()` calls release the Kafka writer and connection pool in reverse order. The whole shutdown story is one readable function — no `SmartLifecycle` phases, no bean destruction ordering, no "why is my `@KafkaListener` still consuming during shutdown."

## Testing

A short section, because the demo keeps it focused, but the philosophy difference deserves a mention. Since validation is plain code, its test is plain too — table-driven, stdlib only, no context to boot:

```go
func TestCreateOrderRequestValidate(t *testing.T) {
    valid := CreateOrderRequest{
        CustomerEmail: "jane@example.com",
        Item:          "widget",
        Quantity:      2,
        TotalCents:    1999,
    }

    tests := []struct {
        name      string
        mutate    func(*CreateOrderRequest)
        wantField string
    }{
        {"valid request", func(r *CreateOrderRequest) {}, ""},
        {"blank email", func(r *CreateOrderRequest) { r.CustomerEmail = "" }, "customerEmail"},
        {"zero quantity", func(r *CreateOrderRequest) { r.Quantity = 0 }, "quantity"},
        // ...
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            req := valid
            tt.mutate(&req)
            errs := req.Validate()
            // assert on errs[tt.wantField]
        })
    }
}
```

The table-driven pattern is Go's `@ParameterizedTest`, and it's ubiquitous. For the service layer, remember section 1: `orders.Service` depends on consumer-side interfaces, so a test fake is a struct with one method — no Mockito, no `@MockBean`, no Spring context. The Go equivalents of Testcontainers exist too ([testcontainers-go](https://golang.testcontainers.org/) is first-party), so integration testing against real Postgres and Kafka translates directly.

## Seeing It Run

The repo ships a `docker-compose.yml` with Postgres (two databases — each service owns its schema), Kafka, Keycloak with a pre-imported `demo` realm, a Kafka UI, and a small Go stub standing in for the payment and inventory APIs (it validates the bearer tokens for real). Then:

```bash
docker compose up -d --build

# Spring (port 8080)
cd spring-app && ./gradlew bootRun

# Go (port 8081) — in another terminal
cd go-app && go run .
```

Grab a token and create an order:

```bash
export TOKEN=$(curl -s http://localhost:8090/realms/demo/protocol/openid-connect/token \
  -d grant_type=client_credentials \
  -d client_id=orders-api-client \
  -d client_secret=orders-api-client-secret | jq -r .access_token)

ORDER_ID=$(curl -s -X POST http://localhost:8080/api/orders \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"customerEmail":"jane@example.com","item":"widget","quantity":2,"totalCents":1999}' | jq -r .id)
```

Fetch it back a second later and the `status` is `COMPLETED` with a `paymentId` — proving the Kafka round-trip and both OAuth2 downstream calls ran:

```bash
curl -s http://localhost:8080/api/orders/$ORDER_ID -H "Authorization: Bearer $TOKEN" | jq
```

```json
{
  "id": "cb068640-8a29-4996-ad21-a10b30652b75",
  "customerEmail": "jane@example.com",
  "item": "widget",
  "quantity": 2,
  "totalCents": 1999,
  "status": "COMPLETED",
  "paymentId": "pay-30a958c6",
  "failureReason": null,
  "createdAt": "2026-07-16T20:02:36.844659Z",
  "updatedAt": "2026-07-16T20:02:36.962628Z"
}
```

Run both apps at once and watch the logs interleave — an order created against the Go app on 8081 shows up in both consumers' logs (each consumer group gets its own copy; each service skips events for orders it doesn't own):

```text
2026-07-16T16:07:53.489 - [spring-order-service] : Created order 611a991a-7728-4d57-8d37-a32ec242d688 for jane@example.com
2026-07-16T16:07:53.509 - [spring-order-service] : Received ORDER_CREATED for order 611a991a-7728-4d57-8d37-a32ec242d688 from spring-order-service
2026-07-16T16:07:53.568 - [spring-order-service] : Order 611a991a-7728-4d57-8d37-a32ec242d688 completed (payment pay-6036108b)
time=2026-07-16T16:07:53.499 type=ORDER_CREATED orderId=611a991a-7728-4d57-8d37-a32ec242d688 source=spring-order-service
2026-07-16T16:07:56.262 - [spring-order-service] : Pending/processing orders: 0

```

Try the failure paths too: no token → `401`, `"quantity": 0` → an identical `problem+json` `400` from either service.

## The Trade-Off in One Table

| Dimension              | Spring Boot                             | Go                                       |
| ---------------------- | --------------------------------------- | ---------------------------------------- |
| Wiring                 | Component scan + DI container           | `func main()` calls constructors         |
| Lines of code          | Fewer; behavior in annotations/starters | More; behavior in visible code           |
| Learning curve         | Know the framework's conventions        | Know the language + a few libraries      |
| "Where does X happen?" | Somewhere in auto-config                | On a line you wrote                      |
| Startup                | Reflection, classpath scanning          | Compiled, direct — starts in ms          |
| Deployable             | JAR + JVM                               | Single static binary                     |
| Testing                | Context slices, mocks, `@MockBean`      | Plain structs + consumer-side interfaces |
| Failure modes          | Misconfiguration, bean conflicts        | Boilerplate, easy-to-forget steps        |

Neither column is the right answer. Spring's leverage is real: this service is meaningfully less code in Java, and the starters encode years of hard-won defaults — the JWT validation section alone shows what you take on when you leave them behind. Go's leverage is also real: there's no framework to learn or fight, the binary starts instantly, and every behavior is on a line you can read.

## Wrapping Up

If you're a Spring developer staring down your first Go service, here's the compressed version of everything above:

1. **`main()` is your auto-configuration.** Construct everything, wire it by hand, and treat the order of statements as your dependency graph.
2. **The standard library goes further than you think.** Routing with method+path patterns, JSON, HTTP client and server, crypto — a typical JSON API needs no framework at all.
3. **Interfaces belong to the consumer.** Declare small interfaces where they're used, and testing stops needing a mocking framework.
4. **Errors are values, and `context.Context` is everywhere.** The two idioms that feel like noise in week one are the two that make production debugging pleasant in month six.
5. **Goroutines + channels + `select` replace the framework's thread machinery.** `@KafkaListener`, `@Scheduled`, and graceful shutdown are all the same pattern: a loop in a goroutine, hanging off a cancellable context.
6. **Respect what the starters were doing for you** — especially in security. Port the _checklist_ (algorithm pinning, expiry required, issuer validation), not just the happy path.

The full project — both services, the JWT-validating downstream stub, the Keycloak realm import, docker-compose for the infrastructure, and a `GOLANG_REFERENCE.md` that maps every concern in this post to the exact files implementing it — is at [github.com/StevenPG/DemosAndArticleContent](https://github.com/StevenPG/DemosAndArticleContent/tree/main/blog/spring-boot-vs-golang). Clone it, run both apps side by side, and diff the implementations concern by concern; it's the fastest way I know to make Go feel familiar.

If you found this useful, the [GraalVM native Spring Boot vs Go benchmark](/posts/go-vs-spring-boot-native-benchmark) measures these same two stacks quantitatively, and the [Spring Boot 4 migration guide](/posts/ultimate-guide-spring-boot-4-migration) and [Spring gRPC guide](/posts/ultimate-guide-spring-grpc) follow this same format for staying current on the Java side of the fence.
