---
author: StevenPG
pubDatetime: 2025-11-03T12:00:00.000Z
title: Spring Boot 4 - What is JSpecify?
slug: spring-boot-4-what-is-jspecify
featured: false
draft: false
ogImage: https://i.imgur.com/4ICZldG.jpeg
tags:
  - software
  - spring boot
  - java
description: An article walking through JSpecify support in Spring Boot 4.
---

# Spring Boot 4 and JSpecify: A New Era of Null Safety in Java

The Spring Boot 4 release brings exciting improvements to the framework, but one feature that deserves special attention is the official support for JSpecify annotations. If you've been frustrated with null pointer exceptions or wished for better static analysis in your Spring applications, this integration is a game-changer.

## What is JSpecify?

JSpecify is a collaborative effort by multiple organizations (including Google, JetBrains, and Uber) to create a standard set of nullness annotations for Java. Think of it as a lingua franca for null safety—a common language that different static analysis tools can understand.

Before JSpecify, the Java ecosystem was fragmented. You had `@Nullable` and `@NotNull` annotations from JSR-305, JetBrains, Eclipse, Android, and others. Each tool preferred its own flavor, creating confusion and compatibility issues. JSpecify aims to solve this by providing a single, well-designed standard.

**[SCREENSHOT: Comparison of different nullable annotation packages in a typical Spring project before JSpecify]**

## What JSpecify Can Do

### 1. Null Safety Guarantees

JSpecify provides annotations that let you express nullness contracts in your code:

```java
import org.jspecify.annotations.Nullable;
import org.jspecify.annotations.NullMarked;

@NullMarked
public class UserService {
    
    // This method guarantees a non-null return
    public User findById(Long id) {
        return userRepository.findById(id)
            .orElseThrow(() -> new UserNotFoundException(id));
    }
    
    // This method might return null
    public @Nullable User findByEmail(String email) {
        return userRepository.findByEmail(email)
            .orElse(null);
    }
}
```

The `@NullMarked` annotation is particularly powerful—it establishes a "null-safe zone" where all types are non-null by default unless explicitly marked with `@Nullable`. This is a massive shift from Java's traditional "everything might be null" approach.

### 2. Better IDE Integration

IntelliJ IDEA has excellent support for JSpecify. Once you've added the annotations, IDEA will:

- Warn you when you try to pass a nullable value where a non-null is expected
- Highlight potential null dereferences
- Suggest fixes and safe alternatives
- Provide dataflow analysis to track nullness through your code

**[SCREENSHOT: IntelliJ IDEA showing a warning when passing a @Nullable value to a non-null parameter]**

### 3. Generic Type Nullness

One of JSpecify's most sophisticated features is its support for generic type arguments:

```java
@NullMarked
public class ResponseWrapper<T> {
    
    // List contains non-null strings
    public List<String> getNonNullStrings() {
        return List.of("foo", "bar");
    }
    
    // List might contain null strings
    public List<@Nullable String> getPossiblyNullStrings() {
        return Arrays.asList("foo", null, "bar");
    }
    
    // The list itself might be null, contains non-null strings
    public @Nullable List<String> getMaybeList() {
        return shouldReturnNull() ? null : List.of("data");
    }
}
```

This level of granularity is something most other nullness annotation systems can't match.

## What JSpecify Cannot Do

It's important to understand JSpecify's limitations:

### 1. Not Runtime Validation

JSpecify annotations are primarily for static analysis. They don't enforce contracts at runtime:

```java
@NullMarked
public class ProductService {
    
    public Product create(String name, BigDecimal price) {
        // If someone calls this via reflection or from non-JSpecify code,
        // nothing prevents null values at runtime
        return new Product(name, price);
    }
}
```

If you need runtime validation, combine JSpecify with Bean Validation (JSR-380):

```java
@NullMarked
public class ProductService {
    
    public Product create(
            @NotBlank String name,  // Runtime validation
            @NotNull @Positive BigDecimal price) {
        return new Product(name, price);
    }
}
```

### 2. No Framework Magic

JSpecify won't automatically handle null safety in framework-level operations. For example, it won't:

- Make Spring's `@Autowired` dependencies null-safe by default
- Validate request parameters in Spring MVC controllers
- Handle database null values in JPA entities

These concerns still need to be addressed at the framework level.

### 3. Not a Silver Bullet for Legacy Code

Adding JSpecify to a large, existing codebase requires careful migration. You can't just slap `@NullMarked` everywhere and expect it to work:

```java
// This might reveal hundreds of potential issues
@NullMarked
public class LegacyService {
    // Existing code that assumes nullability everywhere
}
```

## Using JSpecify with Spring Boot 4

Spring Boot 4 has embraced JSpecify throughout its codebase, and the good news is that the JSpecify dependency will be included transitively through Spring Boot's starter dependencies.

### 1. Check Your Dependencies

First, verify that JSpecify is available in your project. Run:

```bash
mvn dependency:tree | grep jspecify
```

Or for Gradle:

```bash
./gradlew dependencies | grep jspecify
```

**[SCREENSHOT: Terminal output showing jspecify in the dependency tree]**

You should see it listed as a transitive dependency. If for some reason it's not present, or you want to ensure a specific version, you can add it explicitly:

```xml
<dependency>
    <groupId>org.jspecify</groupId>
    <artifactId>jspecify</artifactId>
    <!-- Version managed by Spring Boot -->
</dependency>
```

Or with Gradle:

```groovy
implementation 'org.jspecify:jspecify'
```

Note that you don't need to specify a version—Spring Boot's dependency management will handle that for you.

### 2. Understanding the Scope

The JSpecify annotations are typically compile-time only. They're retained in the bytecode for tools to read, but they don't add any runtime dependencies or overhead to your application. This means:

- Your compiled application won't have a runtime dependency on JSpecify
- The annotations are there for static analysis tools and IDEs
- No performance impact

### 3. Annotate Your Spring Components

Start with new code or high-risk areas:

```java
import org.jspecify.annotations.Nullable;
import org.jspecify.annotations.NullMarked;
import org.springframework.stereotype.Service;

@Service
@NullMarked
public class OrderService {
    
    private final OrderRepository orderRepository;
    private final PaymentService paymentService;
    
    public OrderService(
            OrderRepository orderRepository,
            PaymentService paymentService) {
        this.orderRepository = orderRepository;
        this.paymentService = paymentService;
    }
    
    public Order createOrder(CreateOrderRequest request) {
        // JSpecify ensures request is non-null
        var order = new Order(
            request.getCustomerId(),
            request.getItems()
        );
        return orderRepository.save(order);
    }
    
    public @Nullable Order findById(Long id) {
        return orderRepository.findById(id).orElse(null);
    }
    
    public Order getByIdOrThrow(Long id) {
        return orderRepository.findById(id)
            .orElseThrow(() -> new OrderNotFoundException(id));
    }
}
```

### 4. Spring's Built-in Annotations

Spring Boot 4 comes with JSpecify annotations on many framework classes, but Spring also maintains its own null-safety annotations (`@NonNull`, `@Nullable`) for backward compatibility. You can use both:

```java
@RestController
@NullMarked
public class UserController {
    
    private final UserService userService;
    
    public UserController(UserService userService) {
        this.userService = userService;
    }
    
    @GetMapping("/users/{id}")
    public ResponseEntity<User> getUser(@PathVariable Long id) {
        User user = userService.findById(id);
        return user != null 
            ? ResponseEntity.ok(user)
            : ResponseEntity.notFound().build();
    }
}
```

## IntelliJ IDEA Setup

IntelliJ IDEA 2024.1+ has built-in support for JSpecify. Here's how to enable it:

### 1. Enable Inspections

Go to **Settings → Editor → Inspections** and enable:
- JVM languages → Probable bugs → Nullability problems
- JVM languages → Probable bugs → Constant conditions & exceptions

**[SCREENSHOT: IntelliJ IDEA inspection settings with JSpecify-related inspections highlighted]**

### 2. Configure Analysis Scope

IDEA will analyze your code as you type, but you can run a full inspection:

**[SCREENSHOT: "Analyze → Inspect Code" menu showing null-safety inspection results]**

### 3. Quick Fixes

When IDEA detects a potential null-safety issue, it offers quick fixes:

```java
@NullMarked
public class CustomerService {
    
    public void processCustomer(@Nullable Customer customer) {
        // IDEA warns: customer might be null
        String name = customer.getName(); // ⚠️ Warning here
    }
}
```

IDEA will suggest:
- Adding a null check
- Using Optional
- Changing the method signature

**[SCREENSHOT: IntelliJ quick-fix popup showing null-safety suggestions]**

## Practical Patterns

### Pattern 1: Optional vs @Nullable

Both `Optional` and `@Nullable` express potential absence, but they have different use cases:

```java
@NullMarked
public class ProductService {
    
    // Use @Nullable for fields and parameters
    private @Nullable Cache cache;
    
    // Use Optional for return values (Spring Data style)
    public Optional<Product> findBySku(String sku) {
        return productRepository.findBySku(sku);
    }
    
    // Or use @Nullable for simpler cases
    public @Nullable Product findCached(String sku) {
        return cache != null ? cache.get(sku) : null;
    }
}
```

### Pattern 2: Gradual Migration

Don't annotate everything at once. Use the `@NullUnmarked` annotation to exclude parts of your codebase:

```java
@NullMarked
public class ModernService {
    // New code with null safety
}

@NullUnmarked
public class LegacyService {
    // Old code, not yet migrated
}
```

### Pattern 3: Integration with Validation

Combine JSpecify with Bean Validation for comprehensive safety:

```java
@NullMarked
public class RegistrationController {
    
    @PostMapping("/register")
    public ResponseEntity<User> register(
            @Valid @RequestBody RegistrationRequest request) {
        
        // JSpecify: request is non-null at compile time
        // @Valid: fields are validated at runtime
        User user = userService.register(request);
        return ResponseEntity.ok(user);
    }
}

public record RegistrationRequest(
    @NotBlank String username,
    @NotBlank @Email String email,
    @NotBlank @Size(min = 8) String password
) {}
```

## Common Pitfalls

### 1. Mixing Annotation Types

Don't mix JSpecify with other nullness annotations in the same module:

```java
// ❌ Don't do this
import org.jspecify.annotations.Nullable;
import javax.annotation.Nonnull;

public class Service {
    public @Nonnull String getOne() { ... }
    public @Nullable String getTwo() { ... }
}
```

Pick one and stick with it. For new Spring Boot 4 projects, choose JSpecify.

### 2. Forgetting @NullMarked

Without `@NullMarked`, JSpecify defaults to permissive mode:

```java
// This doesn't enforce non-null by default
public class Service {
    public String get() { return null; } // No warning!
}

// This does
@NullMarked
public class Service {
    public String get() { return null; } // ⚠️ Warning!
}
```

### 3. Over-using @Nullable

Don't mark everything as `@Nullable` to make warnings go away:

```java
// ❌ Bad
@NullMarked
public class Service {
    public @Nullable String getName(@Nullable User user) {
        return user != null ? user.getName() : null;
    }
}

// ✅ Better - make nullability explicit and use Optional
@NullMarked
public class Service {
    public String getNameOrDefault(User user) {
        return user.getName();
    }
    
    public Optional<String> findName(@Nullable User user) {
        return Optional.ofNullable(user)
            .map(User::getName);
    }
}
```

## Conclusion

JSpecify support in Spring Boot 4 represents a significant step forward for null safety in the Java ecosystem. While it's not a magic solution that will eliminate all NPEs, it provides powerful tools for expressing and enforcing nullness contracts at compile time.

The key is to approach it incrementally: start with new code, gradually migrate high-risk areas, and let your IDE guide you. Combined with IntelliJ IDEA's excellent tooling support, JSpecify can dramatically improve the reliability of your Spring applications.

As the Spring ecosystem continues to adopt JSpecify throughout its libraries, we'll see better interoperability and more consistent null-safety practices across the board. Now is a great time to start incorporating these patterns into your projects.

---

*Have you started using JSpecify in your Spring Boot projects? What challenges have you encountered? Let me know in the comments below.*
