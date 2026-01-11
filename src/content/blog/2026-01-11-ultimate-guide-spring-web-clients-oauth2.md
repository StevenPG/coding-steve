---
author: StevenPG
pubDatetime: 2026-01-11T12:00:00.000Z
title: "The Ultimate Guide to Spring Web Clients with OAuth2"
slug: ultimate-guide-spring-web-clients-oauth2
featured: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - spring boot
  - java
  - oauth2
  - spring-security
description: A comprehensive guide to Spring's HTTP clients - RestClient, WebClient, and declarative interfaces - with complete OAuth2 integration patterns.
---

# The Ultimate Guide to Spring Web Clients with OAuth2

## Table of Contents

[[toc]]

## Introduction

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. Spring's HTTP client landscape has evolved significantly, and the documentation is scattered across multiple versions, blog posts, and Stack Overflow answers. This guide consolidates everything you need to know about making HTTP calls with OAuth2 authentication in Spring.

We're at an interesting inflection point in the Spring ecosystem. RestTemplate is on its way out, RestClient is the new standard, and Spring Boot 4 introduces zero-configuration declarative clients. If you're confused about which client to use or how to properly integrate OAuth2, you're in the right place.

### What This Guide Covers

- **RestTemplate**: Brief history and why it's being deprecated
- **RestClient**: The modern synchronous HTTP client with full OAuth2 support
- **WebClient**: Reactive HTTP client for Spring WebFlux applications
- **Declarative Clients**: `@HttpExchange` interfaces with `HttpServiceProxyFactory` and Spring Boot 4's `@ImportHttpServices`
- **OAuth2 Integration**: Client Credentials and Refresh Token flows
- **Production Concerns**: Testing, observability, resilience, and GraalVM native images

### A Quick OAuth2 Refresher

Before diving in, let's establish common terminology. OAuth2 is an authorization framework for service-to-service and user-to-application authentication. For this guide, we focus on two grant types:

| Grant Type | Use Case | Flow |
|------------|----------|------|
| **Client Credentials** | Service-to-service (M2M) | Client sends credentials directly to token endpoint |
| **Refresh Token** | Token renewal | Use refresh token to get new access token without re-authentication |

Key components:
- **Client Registration**: Your application's OAuth2 credentials (client ID, secret, scopes)
- **Provider**: The OAuth2 authorization server (Keycloak, Okta, Azure AD)
- **Authorized Client**: A client that has obtained an access token

### Spring Version Timeline

Understanding the deprecation timeline helps with planning:

| Version | Status | Key Changes |
|---------|--------|-------------|
| Spring Framework 6.1 | Current | RestClient introduced |
| Spring Security 6.4 | Current | `OAuth2ClientHttpRequestInterceptor` for RestClient |
| Spring Boot 4.0 | Current | `@ImportHttpServices` for zero-config declarative clients |
| Spring Framework 7.1 | Nov 2026 | RestTemplate deprecated |
| Spring Framework 8 | Future | RestTemplate removed |

## RestTemplate: The Legacy Approach

RestTemplate served the Spring community well for over a decade. If you're working with a legacy codebase, you'll likely encounter it.

```java
// The old way - still works but don't use for new code
@Bean
public RestTemplate restTemplate() {
    return new RestTemplateBuilder()
        .rootUri("https://api.example.com")
        .build();
}
```

### Why RestTemplate is Being Deprecated

1. **Synchronous-only design**: No native support for reactive patterns
2. **Maintenance burden**: Two parallel APIs (RestTemplate and WebClient) to maintain
3. **Modern alternatives**: RestClient provides the same simplicity with modern features
4. **Inconsistent API**: Some methods accept URI templates, others don't

### Migration Path

The good news: migrating from RestTemplate to RestClient is straightforward. The APIs are similar, and you can even create a RestClient from an existing RestTemplate:

```java
// Quick migration path
RestTemplate legacyTemplate = new RestTemplate();
RestClient modernClient = RestClient.create(legacyTemplate);
```

For new code, skip RestTemplate entirely and go straight to RestClient.

## Modern HTTP Clients Overview

Spring offers two modern HTTP clients, each suited for different application types.

### RestClient vs WebClient

| Aspect | RestClient | WebClient |
|--------|------------|-----------|
| **Programming Model** | Synchronous (blocking) | Reactive (non-blocking) |
| **Best For** | Spring MVC applications | Spring WebFlux applications |
| **Dependencies** | `spring-boot-starter-web` | `spring-boot-starter-webflux` |
| **Thread Model** | One thread per request | Event-loop with backpressure |
| **OAuth2 Support** | `OAuth2ClientHttpRequestInterceptor` | `ServerOAuth2AuthorizedClientExchangeFilterFunction` |
| **Learning Curve** | Lower (familiar patterns) | Higher (reactive concepts) |

### When to Use Which

**Choose RestClient when:**
- Building a traditional Spring MVC application
- Team is more comfortable with synchronous code
- Making occasional HTTP calls where blocking is acceptable
- Integrating with blocking libraries or databases

**Choose WebClient when:**
- Building a Spring WebFlux application
- Need non-blocking I/O throughout the stack
- Making many concurrent HTTP calls
- Streaming responses or server-sent events

**Rule of thumb:** If your application uses `spring-boot-starter-web`, use RestClient. If it uses `spring-boot-starter-webflux`, use WebClient.

## RestClient Fundamentals

Before adding OAuth2, let's understand RestClient basics. This section shows RestClient without authentication - we'll add OAuth2 in the next section.

### Basic Setup

```java
@Configuration
public class RestClientConfig {

    @Bean
    public RestClient restClient() {
        return RestClient.builder()
                // Base URL for all requests
                .baseUrl("https://api.example.com")
                // Default headers applied to every request
                .defaultHeader("Accept", "application/json")
                // Connection timeouts
                .requestFactory(clientHttpRequestFactory())
                .build();
    }

    private ClientHttpRequestFactory clientHttpRequestFactory() {
        // Configure connection and read timeouts
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(Duration.ofSeconds(5));
        factory.setReadTimeout(Duration.ofSeconds(30));
        return factory;
    }
}
```

### Making Requests

RestClient provides a fluent API for all HTTP methods:

```java
@Service
@RequiredArgsConstructor
public class ApiService {

    private final RestClient restClient;

    // GET request returning a single object
    public User getUser(Long id) {
        return restClient.get()
                .uri("/users/{id}", id)
                .retrieve()
                .body(User.class);
    }

    // GET request returning a list
    public List<User> getAllUsers() {
        return restClient.get()
                .uri("/users")
                .retrieve()
                .body(new ParameterizedTypeReference<List<User>>() {});
    }

    // POST request with body
    public User createUser(CreateUserRequest request) {
        return restClient.post()
                .uri("/users")
                .contentType(MediaType.APPLICATION_JSON)
                .body(request)
                .retrieve()
                .body(User.class);
    }

    // PUT request
    public User updateUser(Long id, UpdateUserRequest request) {
        return restClient.put()
                .uri("/users/{id}", id)
                .contentType(MediaType.APPLICATION_JSON)
                .body(request)
                .retrieve()
                .body(User.class);
    }

    // DELETE request
    public void deleteUser(Long id) {
        restClient.delete()
                .uri("/users/{id}", id)
                .retrieve()
                .toBodilessEntity();
    }
}
```

### Error Handling

RestClient throws exceptions for error responses by default. Customize handling with `onStatus`:

```java
public User getUser(Long id) {
    return restClient.get()
            .uri("/users/{id}", id)
            .retrieve()
            // Handle 404 specifically
            .onStatus(HttpStatusCode::is4xxClientError, (request, response) -> {
                if (response.getStatusCode() == HttpStatus.NOT_FOUND) {
                    throw new UserNotFoundException("User not found: " + id);
                }
                throw new ClientException("Client error: " + response.getStatusCode());
            })
            // Handle 5xx errors
            .onStatus(HttpStatusCode::is5xxServerError, (request, response) -> {
                throw new ServerException("Server error: " + response.getStatusCode());
            })
            .body(User.class);
}
```

### Request Interceptors

Interceptors modify requests before they're sent - perfect for adding headers, logging, or authentication:

```java
@Bean
public RestClient restClient() {
    return RestClient.builder()
            .baseUrl("https://api.example.com")
            .requestInterceptor((request, body, execution) -> {
                // Add correlation ID to every request
                request.getHeaders().add("X-Correlation-ID", UUID.randomUUID().toString());
                // Log the request
                log.debug("Calling {} {}", request.getMethod(), request.getURI());
                // Execute the request
                ClientHttpResponse response = execution.execute(request, body);
                // Log the response
                log.debug("Response status: {}", response.getStatusCode());
                return response;
            })
            .build();
}
```

## WebClient Fundamentals

WebClient is Spring's reactive HTTP client. If you're using Spring WebFlux, this is your tool.

### Basic Setup

```java
@Configuration
public class WebClientConfig {

    @Bean
    public WebClient webClient() {
        return WebClient.builder()
                .baseUrl("https://api.example.com")
                .defaultHeader("Accept", "application/json")
                // Configure connection pool and timeouts
                .clientConnector(new ReactorClientHttpConnector(
                        HttpClient.create()
                                .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 5000)
                                .responseTimeout(Duration.ofSeconds(30))
                ))
                .build();
    }
}
```

### Making Reactive Requests

WebClient returns `Mono` (single value) or `Flux` (stream of values):

```java
@Service
@RequiredArgsConstructor
public class ReactiveApiService {

    private final WebClient webClient;

    // GET returning Mono
    public Mono<User> getUser(Long id) {
        return webClient.get()
                .uri("/users/{id}", id)
                .retrieve()
                .bodyToMono(User.class);
    }

    // GET returning Flux
    public Flux<User> getAllUsers() {
        return webClient.get()
                .uri("/users")
                .retrieve()
                .bodyToFlux(User.class);
    }

    // POST with body
    public Mono<User> createUser(CreateUserRequest request) {
        return webClient.post()
                .uri("/users")
                .contentType(MediaType.APPLICATION_JSON)
                .bodyValue(request)
                .retrieve()
                .bodyToMono(User.class);
    }

    // Error handling in reactive style
    public Mono<User> getUserWithErrorHandling(Long id) {
        return webClient.get()
                .uri("/users/{id}", id)
                .retrieve()
                .onStatus(HttpStatusCode::is4xxClientError, response ->
                        Mono.error(new UserNotFoundException("User not found: " + id)))
                .onStatus(HttpStatusCode::is5xxServerError, response ->
                        Mono.error(new ServerException("Server error")))
                .bodyToMono(User.class);
    }
}
```

### ExchangeFilterFunction

WebClient uses filters instead of interceptors:

```java
@Bean
public WebClient webClient() {
    return WebClient.builder()
            .baseUrl("https://api.example.com")
            .filter(ExchangeFilterFunction.ofRequestProcessor(clientRequest -> {
                log.debug("Request: {} {}", clientRequest.method(), clientRequest.url());
                return Mono.just(clientRequest);
            }))
            .filter(ExchangeFilterFunction.ofResponseProcessor(clientResponse -> {
                log.debug("Response status: {}", clientResponse.statusCode());
                return Mono.just(clientResponse);
            }))
            .build();
}
```

## OAuth2 Foundations for Spring Clients

Now let's add OAuth2 to our HTTP clients. First, the dependencies and configuration that apply to both RestClient and WebClient.

### Dependencies

```groovy
// build.gradle
dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-web' // or webflux
    implementation 'org.springframework.boot:spring-boot-starter-security'
    implementation 'org.springframework.security:spring-security-oauth2-client'
}
```

### Client Registration Configuration

Define your OAuth2 providers in `application.yml`. Here's a complete example using Keycloak:

```yaml
spring:
  security:
    oauth2:
      client:
        registration:
          # Registration ID - used to select this client programmatically
          keycloak-service:
            client-id: ${KEYCLOAK_CLIENT_ID:my-service}
            client-secret: ${KEYCLOAK_CLIENT_SECRET}
            authorization-grant-type: client_credentials
            scope: openid,profile
            provider: keycloak

          # Second registration for a different service
          partner-api:
            client-id: ${PARTNER_CLIENT_ID}
            client-secret: ${PARTNER_CLIENT_SECRET}
            authorization-grant-type: client_credentials
            scope: orders:read,inventory:read
            provider: partner

        provider:
          keycloak:
            token-uri: ${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token
            issuer-uri: ${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}
          partner:
            token-uri: https://auth.partner-company.com/oauth2/token
```

### OAuth2AuthorizedClientManager

The `OAuth2AuthorizedClientManager` is the core component for obtaining and managing tokens. Spring auto-configures one, but you may need to customize it:

```java
@Configuration
public class OAuth2ClientConfig {

    @Bean
    public OAuth2AuthorizedClientManager authorizedClientManager(
            ClientRegistrationRepository clientRegistrationRepository,
            OAuth2AuthorizedClientService authorizedClientService) {

        // Create the manager with repositories
        AuthorizedClientServiceOAuth2AuthorizedClientManager manager =
                new AuthorizedClientServiceOAuth2AuthorizedClientManager(
                        clientRegistrationRepository,
                        authorizedClientService);

        // Configure which grant types to support
        OAuth2AuthorizedClientProvider authorizedClientProvider =
                OAuth2AuthorizedClientProviderBuilder.builder()
                        .clientCredentials()  // Support client credentials
                        .refreshToken()       // Support refresh tokens
                        .build();

        manager.setAuthorizedClientProvider(authorizedClientProvider);

        return manager;
    }
}
```

## RestClient with OAuth2

Now we combine RestClient with OAuth2 using `OAuth2ClientHttpRequestInterceptor`, introduced in Spring Security 6.4.

### Client Credentials Setup

```java
@Configuration
@RequiredArgsConstructor
public class OAuth2RestClientConfig {

    // The registration ID from application.yml
    private static final String CLIENT_REGISTRATION_ID = "keycloak-service";

    @Bean
    public OAuth2AuthorizedClientManager authorizedClientManager(
            ClientRegistrationRepository clientRegistrationRepository,
            OAuth2AuthorizedClientService authorizedClientService) {

        AuthorizedClientServiceOAuth2AuthorizedClientManager manager =
                new AuthorizedClientServiceOAuth2AuthorizedClientManager(
                        clientRegistrationRepository, authorizedClientService);

        // Enable client credentials and refresh token flows
        manager.setAuthorizedClientProvider(
                OAuth2AuthorizedClientProviderBuilder.builder()
                        .clientCredentials()
                        .refreshToken()
                        .build());

        return manager;
    }

    @Bean
    public RestClient oauth2RestClient(OAuth2AuthorizedClientManager authorizedClientManager) {
        // Create the OAuth2 interceptor
        OAuth2ClientHttpRequestInterceptor oauth2Interceptor =
                new OAuth2ClientHttpRequestInterceptor(authorizedClientManager);

        // Set which client registration to use for all requests
        oauth2Interceptor.setClientRegistrationIdResolver(request -> CLIENT_REGISTRATION_ID);

        return RestClient.builder()
                .baseUrl("https://api.protected-service.com")
                .requestInterceptor(oauth2Interceptor)
                .build();
    }
}
```

### Using the OAuth2-Enabled RestClient

Once configured, usage is transparent - the interceptor handles tokens automatically:

```java
@Service
@RequiredArgsConstructor
public class ProtectedApiService {

    private final RestClient oauth2RestClient;

    public ProtectedResource getResource(String resourceId) {
        // The OAuth2 interceptor automatically:
        // 1. Obtains a token if we don't have one
        // 2. Refreshes the token if it's expired
        // 3. Adds Authorization: Bearer <token> header
        return oauth2RestClient.get()
                .uri("/resources/{id}", resourceId)
                .retrieve()
                .body(ProtectedResource.class);
    }
}
```

### Handling Authorization Failures

When an API returns 401 or 403, you may want to clear the cached token so the next request obtains a fresh one:

```java
@Bean
public RestClient oauth2RestClient(OAuth2AuthorizedClientManager authorizedClientManager,
                                   OAuth2AuthorizedClientService authorizedClientService) {

    OAuth2ClientHttpRequestInterceptor oauth2Interceptor =
            new OAuth2ClientHttpRequestInterceptor(authorizedClientManager);
    oauth2Interceptor.setClientRegistrationIdResolver(request -> CLIENT_REGISTRATION_ID);

    // Use the built-in helper to create a failure handler that removes invalid tokens
    OAuth2AuthorizationFailureHandler failureHandler =
            OAuth2ClientHttpRequestInterceptor.authorizationFailureHandler(authorizedClientService);
    oauth2Interceptor.setAuthorizationFailureHandler(failureHandler);

    return RestClient.builder()
            .baseUrl("https://api.protected-service.com")
            .requestInterceptor(oauth2Interceptor)
            .build();
}
```

### Multiple Client Registrations

When calling different APIs that require different OAuth2 clients:

```java
@Configuration
public class MultiClientConfig {

    @Bean
    public RestClient keycloakRestClient(OAuth2AuthorizedClientManager manager) {
        OAuth2ClientHttpRequestInterceptor interceptor =
                new OAuth2ClientHttpRequestInterceptor(manager);
        interceptor.setClientRegistrationIdResolver(request -> "keycloak-service");

        return RestClient.builder()
                .baseUrl("https://internal-api.example.com")
                .requestInterceptor(interceptor)
                .build();
    }

    @Bean
    public RestClient partnerRestClient(OAuth2AuthorizedClientManager manager) {
        OAuth2ClientHttpRequestInterceptor interceptor =
                new OAuth2ClientHttpRequestInterceptor(manager);
        interceptor.setClientRegistrationIdResolver(request -> "partner-api");

        return RestClient.builder()
                .baseUrl("https://api.partner-company.com")
                .requestInterceptor(interceptor)
                .build();
    }
}
```

### Dynamic Client Selection

Select the client registration based on request attributes:

```java
@Bean
public RestClient dynamicOAuth2RestClient(OAuth2AuthorizedClientManager manager) {
    OAuth2ClientHttpRequestInterceptor interceptor =
            new OAuth2ClientHttpRequestInterceptor(manager);

    // Resolve client ID from request attribute
    interceptor.setClientRegistrationIdResolver(request -> {
        // Look for client ID in request attributes
        Object clientId = request.getAttributes().get("oauth2.client.registration.id");
        if (clientId != null) {
            return clientId.toString();
        }
        // Default fallback
        return "default-client";
    });

    return RestClient.builder()
            .requestInterceptor(interceptor)
            .build();
}

// Usage
public void callApi(String clientRegistrationId) {
    restClient.get()
            .uri("https://api.example.com/resource")
            .attributes(attrs -> attrs.put("oauth2.client.registration.id", clientRegistrationId))
            .retrieve()
            .body(String.class);
}
```

## WebClient with OAuth2

For reactive applications using WebClient, Spring provides `ServletOAuth2AuthorizedClientExchangeFilterFunction` (servlet) or `ServerOAuth2AuthorizedClientExchangeFilterFunction` (reactive).

### Servlet Stack Configuration

```java
@Configuration
public class OAuth2WebClientConfig {

    @Bean
    public WebClient oauth2WebClient(OAuth2AuthorizedClientManager authorizedClientManager) {
        // Filter function that handles OAuth2 for WebClient
        ServletOAuth2AuthorizedClientExchangeFilterFunction oauth2Filter =
                new ServletOAuth2AuthorizedClientExchangeFilterFunction(authorizedClientManager);

        // Use this registration for all requests
        oauth2Filter.setDefaultClientRegistrationId("keycloak-service");

        return WebClient.builder()
                .baseUrl("https://api.protected-service.com")
                .apply(oauth2Filter.oauth2Configuration())
                .build();
    }
}
```

### Reactive Stack Configuration

For fully reactive applications:

```java
@Configuration
public class ReactiveOAuth2WebClientConfig {

    @Bean
    public ReactiveOAuth2AuthorizedClientManager reactiveAuthorizedClientManager(
            ReactiveClientRegistrationRepository clientRegistrationRepository,
            ServerOAuth2AuthorizedClientRepository authorizedClientRepository) {

        ReactiveOAuth2AuthorizedClientProvider authorizedClientProvider =
                ReactiveOAuth2AuthorizedClientProviderBuilder.builder()
                        .clientCredentials()
                        .refreshToken()
                        .build();

        DefaultReactiveOAuth2AuthorizedClientManager manager =
                new DefaultReactiveOAuth2AuthorizedClientManager(
                        clientRegistrationRepository, authorizedClientRepository);

        manager.setAuthorizedClientProvider(authorizedClientProvider);

        return manager;
    }

    @Bean
    public WebClient oauth2WebClient(ReactiveOAuth2AuthorizedClientManager manager) {
        ServerOAuth2AuthorizedClientExchangeFilterFunction oauth2Filter =
                new ServerOAuth2AuthorizedClientExchangeFilterFunction(manager);

        oauth2Filter.setDefaultClientRegistrationId("keycloak-service");

        return WebClient.builder()
                .baseUrl("https://api.protected-service.com")
                .filter(oauth2Filter)
                .build();
    }
}
```

### Using OAuth2 WebClient

```java
@Service
@RequiredArgsConstructor
public class ReactiveProtectedApiService {

    private final WebClient oauth2WebClient;

    public Mono<ProtectedResource> getResource(String resourceId) {
        return oauth2WebClient.get()
                .uri("/resources/{id}", resourceId)
                .retrieve()
                .bodyToMono(ProtectedResource.class);
    }

    // Specify client registration per request
    public Mono<ProtectedResource> getResourceWithClient(String resourceId, String clientId) {
        return oauth2WebClient.get()
                .uri("/resources/{id}", resourceId)
                .attributes(ServletOAuth2AuthorizedClientExchangeFilterFunction
                        .clientRegistrationId(clientId))
                .retrieve()
                .bodyToMono(ProtectedResource.class);
    }
}
```

## Declarative HTTP Clients

Instead of manually constructing requests, define interfaces and let Spring generate implementations.

### HTTP Interfaces with @HttpExchange

Define your API as an interface:

```java
// Define the API contract
public interface UserApiClient {

    @GetExchange("/users/{id}")
    User getUser(@PathVariable Long id);

    @GetExchange("/users")
    List<User> getAllUsers();

    @GetExchange("/users")
    List<User> searchUsers(@RequestParam String name, @RequestParam(required = false) String email);

    @PostExchange("/users")
    User createUser(@RequestBody CreateUserRequest request);

    @PutExchange("/users/{id}")
    User updateUser(@PathVariable Long id, @RequestBody UpdateUserRequest request);

    @DeleteExchange("/users/{id}")
    void deleteUser(@PathVariable Long id);

    // Reactive variants work too
    @GetExchange("/users/{id}")
    Mono<User> getUserReactive(@PathVariable Long id);
}
```

### Spring Boot 3.x: Manual HttpServiceProxyFactory

In Spring Boot 3.x, you manually create the proxy factory:

```java
@Configuration
public class HttpClientInterfaceConfig {

    @Bean
    public UserApiClient userApiClient(RestClient oauth2RestClient) {
        // Create the proxy factory with our OAuth2-enabled RestClient
        HttpServiceProxyFactory factory = HttpServiceProxyFactory
                .builderFor(RestClientAdapter.create(oauth2RestClient))
                .build();

        // Generate implementation from interface
        return factory.createClient(UserApiClient.class);
    }

    // For multiple interfaces, create multiple beans
    @Bean
    public OrderApiClient orderApiClient(RestClient oauth2RestClient) {
        HttpServiceProxyFactory factory = HttpServiceProxyFactory
                .builderFor(RestClientAdapter.create(oauth2RestClient))
                .build();

        return factory.createClient(OrderApiClient.class);
    }
}
```

### Spring Boot 4: @ImportHttpServices (Zero Config)

Spring Boot 4 simplifies this dramatically with `@ImportHttpServices`:

```java
// That's it! Spring Boot 4 auto-generates proxies
@Configuration
@ImportHttpServices(basePackages = "com.example.clients")
public class HttpClientConfig {
    // No manual factory creation needed!
}
```

With `@ImportHttpServices`, Spring Boot:
1. Scans for interfaces with `@HttpExchange` annotations
2. Auto-creates proxies using the default RestClient
3. Registers them as beans automatically

### Service Groups

The key concept in Spring Boot 4's HTTP clients is **groups**. A group is a set of HTTP service interfaces that share the same configuration (base URL, timeouts, OAuth2 settings).

```java
// Multiple groups for different API providers
@Configuration
@ImportHttpServices(group = "keycloak", basePackages = "com.example.clients.keycloak")
@ImportHttpServices(group = "partner", basePackages = "com.example.clients.partner")
@ImportHttpServices(group = "internal", basePackages = "com.example.clients.internal")
public class HttpClientConfig {
}

// Or import specific types
@Configuration
@ImportHttpServices(group = "keycloak", types = {UserService.class, RoleService.class})
@ImportHttpServices(group = "partner", types = {OrderService.class, InventoryService.class})
public class HttpClientConfig {
}
```

### YAML Configuration for @ImportHttpServices

This is where the magic happens. Configure each group via `spring.http.serviceclient` properties:

```yaml
spring:
  http:
    # Global settings (apply to ALL HTTP clients)
    clients:
      connect-timeout: 5s
      read-timeout: 30s
      redirects: follow  # or dont-follow

    # Per-group configuration for @ImportHttpServices
    serviceclient:
      # Keycloak internal services
      keycloak:
        base-url: ${KEYCLOAK_API_URL:https://keycloak.internal.example.com}
        read-timeout: 5s
        connect-timeout: 1s

      # Partner API
      partner:
        base-url: https://api.partner-company.com
        read-timeout: 15s

      # Internal microservices
      internal:
        base-url: ${INTERNAL_API_URL:http://api-gateway:8080}
        read-timeout: 3s
        connect-timeout: 500ms

      # Default group (used when no group specified in @ImportHttpServices)
      default:
        base-url: https://api.example.com
        read-timeout: 10s
```

### Available Configuration Properties

| Property | Description | Example |
|----------|-------------|---------|
| `spring.http.serviceclient.<group>.base-url` | Base URL for all requests in group | `https://api.example.com` |
| `spring.http.serviceclient.<group>.read-timeout` | Read timeout | `10s` |
| `spring.http.serviceclient.<group>.connect-timeout` | Connection timeout | `2s` |
| `spring.http.serviceclient.<group>.apiversion.default` | Default API version | `1.0.0` |
| `spring.http.serviceclient.<group>.apiversion.insert.header` | Header for API version | `X-Version` |
| `spring.http.clients.connect-timeout` | Global connect timeout (all clients) | `5s` |
| `spring.http.clients.read-timeout` | Global read timeout (all clients) | `30s` |
| `spring.http.clients.redirects` | Global redirect handling | `follow`, `dont-follow` |

### OAuth2 with @ClientRegistrationId (Spring Security 7)

Spring Security 7 introduces `@ClientRegistrationId` for declarative OAuth2 on HTTP interfaces - no manual interceptor setup needed!

```java
// Apply OAuth2 at the interface level - all methods use this registration
@HttpExchange
@ClientRegistrationId("keycloak-service")
public interface ProtectedApiClient {

    @GetExchange("/users/{id}")
    User getUser(@PathVariable Long id);

    @PostExchange("/users")
    User createUser(@RequestBody CreateUserRequest request);
}

// Or apply per-method for mixed authentication
@HttpExchange
public interface MixedApiClient {

    @GetExchange("/public/health")
    HealthStatus getHealth();  // No OAuth2

    @GetExchange("/protected/users")
    @ClientRegistrationId("keycloak-service")  // OAuth2 for this method only
    List<User> getUsers();
}
```

### Enabling OAuth2 for HTTP Service Groups

To enable `@ClientRegistrationId` processing, add the configurer bean:

```java
@Configuration
@ImportHttpServices(group = "keycloak", basePackages = "com.example.clients.keycloak")
public class HttpClientConfig {

    // Enable OAuth2 for all @ImportHttpServices groups
    @Bean
    OAuth2RestClientHttpServiceGroupConfigurer oauth2Configurer(
            OAuth2AuthorizedClientManager authorizedClientManager) {
        return OAuth2RestClientHttpServiceGroupConfigurer.from(authorizedClientManager);
    }
}
```

This single bean:
1. Adds `ClientRegistrationIdProcessor` to process `@ClientRegistrationId` annotations
2. Adds `OAuth2ClientHttpRequestInterceptor` to each RestClient
3. Automatically resolves tokens based on the annotation value

For WebClient (reactive), use the reactive variant:

```java
@Bean
OAuth2WebClientHttpServiceGroupConfigurer oauth2Configurer(
        ReactiveOAuth2AuthorizedClientManager manager) {
    return OAuth2WebClientHttpServiceGroupConfigurer.from(manager);
}
```

### Complete Spring Boot 4 OAuth2 Example

Putting it all together:

```yaml
# application.yml
spring:
  security:
    oauth2:
      client:
        registration:
          keycloak-service:
            client-id: ${KEYCLOAK_CLIENT_ID}
            client-secret: ${KEYCLOAK_CLIENT_SECRET}
            authorization-grant-type: client_credentials
            scope: openid,profile
            provider: keycloak
          partner-api:
            client-id: ${PARTNER_CLIENT_ID}
            client-secret: ${PARTNER_CLIENT_SECRET}
            authorization-grant-type: client_credentials
            scope: orders:read,inventory:read
            provider: partner
        provider:
          keycloak:
            token-uri: ${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token
          partner:
            token-uri: https://auth.partner-company.com/oauth2/token

  http:
    # Global settings
    clients:
      connect-timeout: 5s
      read-timeout: 30s

    # Per-group service client configuration
    serviceclient:
      keycloak:
        base-url: https://api.internal.example.com
        read-timeout: 5s
      partner:
        base-url: https://api.partner-company.com
        read-timeout: 15s
```

```java
// HTTP Service interfaces with OAuth2
@HttpExchange
@ClientRegistrationId("keycloak-service")
public interface InternalApiClient {

    @GetExchange("/users/{id}")
    User getUser(@PathVariable Long id);
}

@HttpExchange
@ClientRegistrationId("partner-api")
public interface PartnerApiClient {

    @GetExchange("/orders/{orderId}")
    Order getOrder(@PathVariable String orderId);

    @GetExchange("/inventory/{sku}")
    InventoryStatus getInventory(@PathVariable String sku);
}
```

```java
// Configuration
@Configuration
@ImportHttpServices(group = "keycloak", types = InternalApiClient.class)
@ImportHttpServices(group = "partner", types = PartnerApiClient.class)
public class HttpClientConfig {

    @Bean
    OAuth2AuthorizedClientManager authorizedClientManager(
            ClientRegistrationRepository clientRegistrationRepository,
            OAuth2AuthorizedClientService authorizedClientService) {

        AuthorizedClientServiceOAuth2AuthorizedClientManager manager =
                new AuthorizedClientServiceOAuth2AuthorizedClientManager(
                        clientRegistrationRepository, authorizedClientService);

        manager.setAuthorizedClientProvider(
                OAuth2AuthorizedClientProviderBuilder.builder()
                        .clientCredentials()
                        .refreshToken()
                        .build());

        return manager;
    }

    @Bean
    OAuth2RestClientHttpServiceGroupConfigurer oauth2Configurer(
            OAuth2AuthorizedClientManager manager) {
        return OAuth2RestClientHttpServiceGroupConfigurer.from(manager);
    }
}
```

```java
// Usage - just inject and use!
@Service
@RequiredArgsConstructor
public class MyService {

    private final InternalApiClient internalApi;  // OAuth2 automatic
    private final PartnerApiClient partnerApi;    // Different OAuth2 client, automatic

    public void doWork() {
        User user = internalApi.getUser(123L);  // Uses keycloak-service token
        Order order = partnerApi.getOrder("ORD-123");  // Uses partner-api token
    }
}
```

### Programmatic Group Configuration

For advanced customization beyond YAML:

```java
@Bean
RestClientHttpServiceGroupConfigurer customGroupConfigurer() {
    return groups -> {
        // Configure specific group
        groups.filterByName("keycloak").forEachClient((group, builder) -> {
            builder.defaultHeader("X-Custom-Header", "value");
        });

        // Configure all groups
        groups.forEachClient((group, builder) -> {
            builder.defaultHeader("X-Service-Name", "my-application");
        });
    };
}
```

### Migration: Spring Boot 3.x to 4.x

Before (Spring Boot 3.x):
```java
@Configuration
public class ClientConfig {
    @Bean
    public UserApiClient userApiClient(RestClient restClient) {
        return HttpServiceProxyFactory
                .builderFor(RestClientAdapter.create(restClient))
                .build()
                .createClient(UserApiClient.class);
    }
}
```

After (Spring Boot 4.x):
```java
@Configuration
@ImportHttpServices(basePackages = "com.example.clients")
public class ClientConfig {
    // That's it!
}
```

With OAuth2 (Spring Boot 4.x + Spring Security 7):
```java
@Configuration
@ImportHttpServices(basePackages = "com.example.clients")
public class ClientConfig {
    @Bean
    OAuth2RestClientHttpServiceGroupConfigurer oauth2(OAuth2AuthorizedClientManager m) {
        return OAuth2RestClientHttpServiceGroupConfigurer.from(m);
    }
}
```

## Advanced OAuth2 Configuration

For non-standard OAuth2 providers or complex requirements.

### Custom Token Endpoints

Some OAuth2 providers require additional parameters. See my article on [Dynamically Setting Audience](/posts/spring-oauth2-client-dynamic-audience) for advanced customization patterns.

Basic example adding a custom parameter:

```java
@Bean
public OAuth2AuthorizedClientManager customAuthorizedClientManager(
        ClientRegistrationRepository clientRegistrationRepository,
        OAuth2AuthorizedClientService authorizedClientService) {

    // Custom token request converter that adds extra parameters
    OAuth2ClientCredentialsGrantRequestEntityConverter converter =
            new OAuth2ClientCredentialsGrantRequestEntityConverter();

    converter.addParametersConverter(grantRequest -> {
        MultiValueMap<String, String> parameters = new LinkedMultiValueMap<>();
        parameters.add("audience", "https://my-api.example.com");
        return parameters;
    });

    // Create provider with custom converter
    DefaultClientCredentialsTokenResponseClient tokenResponseClient =
            new DefaultClientCredentialsTokenResponseClient();
    tokenResponseClient.setRequestEntityConverter(converter);

    ClientCredentialsOAuth2AuthorizedClientProvider provider =
            new ClientCredentialsOAuth2AuthorizedClientProvider();
    provider.setAccessTokenResponseClient(tokenResponseClient);

    AuthorizedClientServiceOAuth2AuthorizedClientManager manager =
            new AuthorizedClientServiceOAuth2AuthorizedClientManager(
                    clientRegistrationRepository, authorizedClientService);
    manager.setAuthorizedClientProvider(provider);

    return manager;
}
```

### Token Caching and Persistence

By default, tokens are stored in memory. For multi-instance deployments, use JDBC storage:

```java
@Bean
public OAuth2AuthorizedClientService authorizedClientService(
        JdbcOperations jdbcOperations,
        ClientRegistrationRepository clientRegistrationRepository) {

    // Store tokens in database - survives restarts, shared across instances
    return new JdbcOAuth2AuthorizedClientService(
            jdbcOperations, clientRegistrationRepository);
}
```

Required database table:
```sql
CREATE TABLE oauth2_authorized_client (
    client_registration_id VARCHAR(100) NOT NULL,
    principal_name VARCHAR(200) NOT NULL,
    access_token_type VARCHAR(100) NOT NULL,
    access_token_value BLOB NOT NULL,
    access_token_issued_at TIMESTAMP NOT NULL,
    access_token_expires_at TIMESTAMP NOT NULL,
    access_token_scopes VARCHAR(1000),
    refresh_token_value BLOB,
    refresh_token_issued_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    PRIMARY KEY (client_registration_id, principal_name)
);
```

## Resilience and Error Handling

Production systems need retry logic and circuit breakers.

### Spring Retry Integration

```java
@Configuration
@EnableRetry
public class RetryConfig {

    @Bean
    public RestClient resilientRestClient(OAuth2AuthorizedClientManager manager) {
        OAuth2ClientHttpRequestInterceptor oauth2Interceptor =
                new OAuth2ClientHttpRequestInterceptor(manager);
        oauth2Interceptor.setClientRegistrationIdResolver(request -> "keycloak-service");

        return RestClient.builder()
                .baseUrl("https://api.example.com")
                .requestInterceptor(oauth2Interceptor)
                .build();
    }
}

@Service
@RequiredArgsConstructor
public class ResilientApiService {

    private final RestClient resilientRestClient;

    // Retry up to 3 times with exponential backoff
    @Retryable(
            retryFor = {RestClientException.class, IOException.class},
            maxAttempts = 3,
            backoff = @Backoff(delay = 1000, multiplier = 2))
    public Resource getResource(String id) {
        return resilientRestClient.get()
                .uri("/resources/{id}", id)
                .retrieve()
                .body(Resource.class);
    }

    @Recover
    public Resource recoverGetResource(Exception e, String id) {
        log.error("All retries exhausted for resource: {}", id, e);
        throw new ServiceUnavailableException("Unable to fetch resource after retries");
    }
}
```

### Circuit Breaker with Resilience4j

```java
@Configuration
public class CircuitBreakerConfig {

    @Bean
    public CircuitBreakerRegistry circuitBreakerRegistry() {
        return CircuitBreakerRegistry.of(
                io.github.resilience4j.circuitbreaker.CircuitBreakerConfig.custom()
                        .failureRateThreshold(50)
                        .waitDurationInOpenState(Duration.ofSeconds(30))
                        .slidingWindowSize(10)
                        .build());
    }
}

@Service
@RequiredArgsConstructor
public class CircuitBreakerApiService {

    private final RestClient restClient;
    private final CircuitBreakerRegistry circuitBreakerRegistry;

    public Resource getResourceWithCircuitBreaker(String id) {
        CircuitBreaker circuitBreaker = circuitBreakerRegistry.circuitBreaker("api-service");

        return circuitBreaker.executeSupplier(() ->
                restClient.get()
                        .uri("/resources/{id}", id)
                        .retrieve()
                        .body(Resource.class));
    }
}
```

## Testing OAuth2 Clients

### Unit Testing with MockRestServiceServer

```java
@SpringBootTest
class ApiServiceTest {

    @Autowired
    private ApiService apiService;

    private MockRestServiceServer mockServer;

    @Autowired
    private RestClient.Builder restClientBuilder;

    @BeforeEach
    void setup() {
        RestClient restClient = restClientBuilder.build();
        mockServer = MockRestServiceServer.bindTo(restClient).build();
    }

    @Test
    void shouldGetUser() {
        mockServer.expect(requestTo("/users/1"))
                .andExpect(header("Authorization", startsWith("Bearer ")))
                .andRespond(withSuccess("""
                        {"id": 1, "name": "John"}
                        """, MediaType.APPLICATION_JSON));

        User user = apiService.getUser(1L);

        assertThat(user.getName()).isEqualTo("John");
        mockServer.verify();
    }
}
```

### Integration Testing with MockOAuth2Server

```java
@SpringBootTest
@AutoConfigureMockMvc
class OAuth2IntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private OAuth2AuthorizedClientService authorizedClientService;

    @Test
    void shouldCallApiWithToken() throws Exception {
        // Mock the authorized client
        OAuth2AccessToken accessToken = new OAuth2AccessToken(
                OAuth2AccessToken.TokenType.BEARER,
                "mock-token",
                Instant.now(),
                Instant.now().plusSeconds(3600));

        OAuth2AuthorizedClient authorizedClient = new OAuth2AuthorizedClient(
                clientRegistration, "user", accessToken);

        when(authorizedClientService.loadAuthorizedClient(eq("keycloak-service"), any()))
                .thenReturn(authorizedClient);

        // Test your endpoint that uses the OAuth2 client
        mockMvc.perform(get("/api/protected-resource"))
                .andExpect(status().isOk());
    }
}
```

### Testing with Keycloak Testcontainers

```java
@SpringBootTest
@Testcontainers
class KeycloakIntegrationTest {

    @Container
    static KeycloakContainer keycloak = new KeycloakContainer()
            .withRealmImportFile("test-realm.json");

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.security.oauth2.client.provider.keycloak.token-uri",
                () -> keycloak.getAuthServerUrl() + "/realms/test/protocol/openid-connect/token");
    }

    @Test
    void shouldObtainTokenFromKeycloak() {
        // Full integration test with real Keycloak
    }
}
```

## Observability

### Logging with Logbook

For detailed request/response logging, see my article on [Logging Request Body with Spring WebClient](/posts/request-body-with-spring-webclient). Here's the RestClient version:

```java
@Bean
public RestClient loggingRestClient(
        OAuth2AuthorizedClientManager manager,
        LogbookClientHttpRequestInterceptor logbookInterceptor) {

    OAuth2ClientHttpRequestInterceptor oauth2Interceptor =
            new OAuth2ClientHttpRequestInterceptor(manager);
    oauth2Interceptor.setClientRegistrationIdResolver(request -> "keycloak-service");

    return RestClient.builder()
            .baseUrl("https://api.example.com")
            // Logbook first to log request before OAuth2 modifies it
            .requestInterceptors(interceptors -> {
                interceptors.add(logbookInterceptor);
                interceptors.add(oauth2Interceptor);
            })
            .build();
}
```

### Metrics with Micrometer

```java
@Bean
public RestClient metricsRestClient(
        OAuth2AuthorizedClientManager manager,
        MeterRegistry meterRegistry) {

    OAuth2ClientHttpRequestInterceptor oauth2Interceptor =
            new OAuth2ClientHttpRequestInterceptor(manager);
    oauth2Interceptor.setClientRegistrationIdResolver(request -> "keycloak-service");

    return RestClient.builder()
            .baseUrl("https://api.example.com")
            .requestInterceptor(oauth2Interceptor)
            // Add observability
            .observationRegistry(ObservationRegistry.create())
            .build();
}
```

## GraalVM Native Image Support

### Basic Configuration

Most OAuth2 client code works with native images out of the box. For custom classes, add hints:

```java
@Configuration
@ImportRuntimeHints(OAuth2NativeHints.class)
public class NativeConfig {
}

class OAuth2NativeHints implements RuntimeHintsRegistrar {

    @Override
    public void registerHints(RuntimeHints hints, ClassLoader classLoader) {
        // Register your DTOs for reflection
        hints.reflection()
                .registerType(User.class, MemberCategory.values())
                .registerType(CreateUserRequest.class, MemberCategory.values());

        // Register OAuth2 classes if using custom implementations
        hints.reflection()
                .registerType(OAuth2AccessToken.class, MemberCategory.values());
    }
}
```

### Native Build

```bash
./mvnw -Pnative native:compile
```

Or with Gradle:
```bash
./gradlew nativeCompile
```

### Known Limitations

- Custom `OAuth2AccessTokenResponseClient` implementations may need reflection hints
- Some OAuth2 providers with unusual token formats may require additional configuration
- Test thoroughly in native mode before deploying

## Common Pitfalls and Troubleshooting

### Token Not Refreshing

**Symptom:** Getting 401 errors after token expires.

**Causes and fixes:**
1. Refresh token support not enabled:
   ```java
   manager.setAuthorizedClientProvider(
           OAuth2AuthorizedClientProviderBuilder.builder()
                   .clientCredentials()
                   .refreshToken()  // Don't forget this!
                   .build());
   ```

2. Token endpoint not returning refresh token - check your OAuth2 provider configuration

### Circular Dependency Issues

**Symptom:** Application fails to start with circular dependency error involving OAuth2 beans.

**Fix:** Use `ObjectProvider` for lazy injection:
```java
@Bean
public RestClient restClient(ObjectProvider<OAuth2AuthorizedClientManager> managerProvider) {
    OAuth2ClientHttpRequestInterceptor interceptor =
            new OAuth2ClientHttpRequestInterceptor(managerProvider.getObject());
    // ...
}
```

### Wrong Client Registration Used

**Symptom:** Calls fail with wrong credentials or scopes.

**Debug:** Enable debug logging:
```yaml
logging:
  level:
    org.springframework.security.oauth2.client: DEBUG
```

## Real-World Example: Calling a Partner API

Complete example calling a partner's B2B API with OAuth2 client credentials:

```yaml
# application.yml
spring:
  security:
    oauth2:
      client:
        registration:
          partner-api:
            client-id: ${PARTNER_CLIENT_ID}
            client-secret: ${PARTNER_CLIENT_SECRET}
            authorization-grant-type: client_credentials
            scope: orders:read,orders:write,inventory:read
        provider:
          partner-api:
            token-uri: https://auth.partner-company.com/oauth2/token
```

```java
@HttpExchange(url = "https://api.partner-company.com/v1", accept = "application/json")
public interface PartnerApiClient {

    @GetExchange("/orders/{orderId}")
    Order getOrder(@PathVariable String orderId);

    @GetExchange("/orders")
    List<Order> getOrdersByStatus(@RequestParam String status);

    @PostExchange("/orders")
    Order createOrder(@RequestBody CreateOrderRequest request);

    @GetExchange("/inventory/{sku}")
    InventoryStatus getInventory(@PathVariable String sku);
}

@Configuration
public class PartnerApiClientConfig {

    @Bean
    public PartnerApiClient partnerApiClient(OAuth2AuthorizedClientManager manager) {
        OAuth2ClientHttpRequestInterceptor oauth2Interceptor =
                new OAuth2ClientHttpRequestInterceptor(manager);
        oauth2Interceptor.setClientRegistrationIdResolver(request -> "partner-api");

        RestClient restClient = RestClient.builder()
                .defaultHeader("X-Api-Version", "2024-01-01")
                .requestInterceptor(oauth2Interceptor)
                .build();

        return HttpServiceProxyFactory
                .builderFor(RestClientAdapter.create(restClient))
                .build()
                .createClient(PartnerApiClient.class);
    }
}
```

## Summary and Quick Reference

### Client Decision Tree

```
Need HTTP client for Spring application?
├── Using Spring WebFlux (reactive)?
│   └── Use WebClient with ServerOAuth2AuthorizedClientExchangeFilterFunction
└── Using Spring MVC (servlet)?
    └── Use RestClient with OAuth2ClientHttpRequestInterceptor
        ├── Spring Boot 3.x: Manual HttpServiceProxyFactory
        └── Spring Boot 4.x: @ImportHttpServices (zero-config)
```

### Configuration Cheat Sheet

**RestClient with OAuth2:**
```java
OAuth2ClientHttpRequestInterceptor interceptor =
        new OAuth2ClientHttpRequestInterceptor(authorizedClientManager);
interceptor.setClientRegistrationIdResolver(request -> "my-client");

RestClient restClient = RestClient.builder()
        .baseUrl("https://api.example.com")
        .requestInterceptor(interceptor)
        .build();
```

**WebClient with OAuth2:**
```java
ServletOAuth2AuthorizedClientExchangeFilterFunction filter =
        new ServletOAuth2AuthorizedClientExchangeFilterFunction(authorizedClientManager);
filter.setDefaultClientRegistrationId("my-client");

WebClient webClient = WebClient.builder()
        .baseUrl("https://api.example.com")
        .apply(filter.oauth2Configuration())
        .build();
```

### Useful Resources

**Official Documentation:**
- [Spring Security OAuth2 Client Documentation](https://docs.spring.io/spring-security/reference/servlet/oauth2/client/index.html)
- [Spring Security HTTP Service Clients Integration](https://docs.spring.io/spring-security/reference/features/integrations/rest/http-service-client.html)
- [Spring Boot HTTP Clients Reference](https://docs.spring.io/spring-boot/reference/io/rest-client.html)
- [Spring Security Authorized Clients](https://docs.spring.io/spring-security/reference/servlet/oauth2/client/authorized-clients.html)

**Blog Posts and Guides:**
- [RestClient OAuth2 Support in Spring Security 6.4](https://spring.io/blog/2024/10/28/restclient-support-for-oauth2-in-spring-security-6-4/)
- [HTTP Service Client Enhancements (Spring Blog)](https://spring.io/blog/2025/09/23/http-service-client-enhancements/)
- [HTTP Interfaces in Spring Boot 4 (Dan Vega)](https://www.danvega.dev/blog/http-interfaces-spring-boot-4)

**My Related Articles:**
- [Easy Spring Rest Client w/ OAuth2](/posts/spring-rest-client-oauth2)
- [Dynamically Setting Audience for Spring OAuth2 Client](/posts/spring-oauth2-client-dynamic-audience)
- [Logging Request Body with Spring WebClient](/posts/request-body-with-spring-webclient)

---

Spring's HTTP client landscape has never been cleaner. RestClient gives you a simple, synchronous API. WebClient handles reactive use cases. `@ImportHttpServices` with `@ClientRegistrationId` eliminates boilerplate and makes OAuth2 declarative. And `OAuth2ClientHttpRequestInterceptor` makes authentication transparent for traditional RestClient usage.

Start with RestClient for new projects. If you're on Spring Boot 4, embrace `@ImportHttpServices` with service groups for zero-configuration HTTP clients, and use `@ClientRegistrationId` for declarative OAuth2. When you hit edge cases with non-standard OAuth2 providers, the advanced configuration options have you covered.
