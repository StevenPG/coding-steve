---
author: StevenPG
pubDatetime: 2025-06-05T12:00:00.000Z
title: Spring Data Pagination Serialization Warning
slug: spring-data-page-impl-serialization-warning
featured: false
ogImage: https://user-images.githubusercontent.com/53733092/215771435-25408246-2309-4f8b-a781-1f3d93bdf0ec.png
tags:
  - spring
  - java
description: A short post detailing a common serialization error and the potential solutions
---

# Fixing Spring Data's PageImpl Serialization Warning

If you're seeing this warning in your Spring Boot application logs,the solution is pretty simple:

```
PageModule$PlainPageSerializationWarning :
  Serializing PageImpl instances as-is is not supported, meaning that there is no guarantee about the stability of the resulting JSON structure!
For a stable JSON structure, please use Spring Data's PagedModel (globally via @EnableSpringDataWebSupport(pageSerializationMode = VIA_DTO))
or Spring HATEOAS and Spring Data's PagedResourcesAssembler as documented
  in https://docs.spring.io/spring-data/commons/reference/repositories/core-extensions.html#core.web.pageables.
```

This warning appears when you're returning `Page<T>` objects directly from your REST controllers, and Spring is warning you that the JSON structure might change between versions.

## The Problem

When you return a `Page<T>` directly from a controller method like this:

```java
@RestController
public class UserController {
    
    @GetMapping("/users")
    public Page<User> getUsers(Pageable pageable) {
        return userRepository.findAll(pageable);
    }
}
```

Spring serializes the `PageImpl` object to JSON, but this serialization isn't guaranteed to be stable across Spring Data versions. The internal structure could change, potentially breaking your API consumers.

## Solution 1: Use PagedModel (Recommended)

The cleanest solution is to enable Spring Data's web support with DTO serialization mode:

```java
@Configuration
@EnableSpringDataWebSupport(pageSerializationMode = VIA_DTO)
public class WebConfig {
}
```

This configuration tells Spring to serialize `Page` objects using a stable DTO structure instead of the internal `PageImpl` structure.

With this configuration, your existing controller methods work exactly the same, but the JSON output will use Spring's stable `PagedModel` format:

```json
{
  "content": [...],
  "page": {
    "size": 20,
    "number": 0,
    "totalElements": 100,
    "totalPages": 5
  }
}
```

## Solution 2: Manual PagedModel Conversion

If you prefer more control, you can manually convert to `PagedModel`:

```java
@RestController
public class UserController {
    
    private final PagedResourcesAssembler<User> pagedAssembler;
    
    public UserController(PagedResourcesAssembler<User> pagedAssembler) {
        this.pagedAssembler = pagedAssembler;
    }
    
    @GetMapping("/users")
    public PagedModel<User> getUsers(Pageable pageable) {
        Page<User> users = userRepository.findAll(pageable);
        return pagedAssembler.toModel(users);
    }
}
```

## Solution 3: Custom Response Wrapper

For more control over the JSON structure, create your own response wrapper:

```java
public class PageResponse<T> {
    private List<T> content;
    private int page;
    private int size;
    private long totalElements;
    private int totalPages;
    
    public PageResponse(Page<T> page) {
        this.content = page.getContent();
        this.page = page.getNumber();
        this.size = page.getSize();
        this.totalElements = page.getTotalElements();
        this.totalPages = page.getTotalPages();
    }
    
    // getters and setters
}
```

Then use it in your controller:

```java
@GetMapping("/users")
public PageResponse<User> getUsers(Pageable pageable) {
    Page<User> users = userRepository.findAll(pageable);
    return new PageResponse<>(users);
}
```

## Why This Matters

While the warning might seem harmless, ignoring it can lead to:

- **Breaking changes**: Future Spring Data updates might change the JSON structure
- **Inconsistent APIs**: Different endpoints might serialize pagination differently
- **Client compatibility issues**: API consumers might break when you upgrade Spring

## Recommendation

Use **Solution 1** with `@EnableSpringDataWebSupport(pageSerializationMode = VIA_DTO)`. It's the least invasive change that provides a stable, standardized JSON structure across your entire application.

The configuration is global, so you only need to add it once, and all your existing `Page<T>` returns will automatically use the stable serialization format.

## Testing the Fix

After implementing the solution, verify the warning is gone by:

1. Starting your application
2. Making a request to an endpoint that returns paginated data
3. Checking your logs - the warning should no longer appear
4. Verifying the JSON response structure matches your expectations

That's it! Your pagination endpoints now use Spring's stable serialization format, and that annoying warning will be gone from your logs.

## But I just want to ignore the error!

Ok, here's the logging config to just hide the warning

```yaml
logging:
  level:
    org.springframework.data.web.PageModule$PlainPageSerializationWarning: ERROR
```
