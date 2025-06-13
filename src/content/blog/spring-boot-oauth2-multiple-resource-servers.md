---
author: StevenPG
pubDatetime: 2025-07-12T12:00:00.000Z
title: Multiple OAuth2 Resource Servers with Spring Boot 3.5.0
slug: spring-boot-oauth2-multiple-resource-servers
featured: false
ogImage: /assets/spring-oauth2-resource-servers.png
tags:
  - software
  - spring boot
  - java
  - oauth
description: How to configure Spring Boot to handle multiple OAuth2 Resource Servers using JwtDecoder based on token issuer
---

## Table of Contents

[[toc]]

# Brief

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things
that caused me trouble. That way, if this is found, someone doesn't have to do the same digging I had to do.

This post assumes you have a basic understanding of OAuth2 and Spring Security. We'll explore how to configure
Spring Boot 3.5.0 to handle multiple OAuth2 Resource Servers using JwtDecoder based on the token issuer.

# What is OAuth2 Resource Server?

A Resource Server in OAuth2 is a server that hosts protected resources and is capable of accepting
and responding to protected resource requests using access tokens. It's the server that actually
holds the data that the client application wants to access.

In Spring Security, the OAuth2 Resource Server support allows your application to validate OAuth2 tokens
from an authorization server and use them to authenticate and authorize requests to your API.

## Key Components of OAuth2 Resource Server

- **JWT Validation**: Verifies the signature, expiration, and claims of JWT tokens
- **Token Introspection**: Validates tokens by calling an introspection endpoint
- **Authorization**: Uses token claims to make authorization decisions
- **Resource Protection**: Secures API endpoints based on token scopes or claims

## Why Multiple Resource Servers?

In modern microservice architectures, you might need to validate tokens from different issuers. For example:

1. Your organization might have multiple authorization servers for different environments or regions
2. You might be integrating with third-party services that have their own authorization servers
3. You might be migrating from one authorization server to another and need to support both during transition

Spring Boot provides elegant solutions for handling multiple token issuers in a single application.

# Setting Up Multiple Resource Servers

Let's dive into how to configure Spring Boot to handle multiple OAuth2 Resource Servers.

## Dependencies

First, add the necessary dependencies to your project:

```gradle
dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-oauth2-resource-server'
    implementation 'org.springframework.boot:spring-boot-starter-web'
    implementation 'org.springframework.boot:spring-boot-starter-security'
}
```

Or if you're using Maven:

```xml
<dependencies>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-oauth2-resource-server</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-security</artifactId>
    </dependency>
</dependencies>
```

## Configuration

The key to supporting multiple resource servers is to create a custom `JwtDecoder` that can determine which issuer to use based on the token itself.

### Basic Configuration

Let's start with a basic configuration in `application.yml`:

```yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          # Primary issuer configuration
          issuer-uri: https://primary-auth-server.com
          jwk-set-uri: https://primary-auth-server.com/.well-known/jwks.json
```

This configuration works for a single issuer, but we need to extend it for multiple issuers.

### Custom Configuration for Multiple Issuers

Create a custom configuration class:

```java
@Configuration
@EnableWebSecurity
public class MultipleResourceServerConfig {

    @Value("${spring.security.oauth2.resourceserver.jwt.issuer-uri}")
    private String primaryIssuerUri;

    @Value("${spring.security.oauth2.resourceserver.jwt.jwk-set-uri}")
    private String primaryJwkSetUri;

    @Value("${custom.security.oauth2.resourceserver.jwt.secondary-issuer-uri}")
    private String secondaryIssuerUri;

    @Value("${custom.security.oauth2.resourceserver.jwt.secondary-jwk-set-uri}")
    private String secondaryJwkSetUri;

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
            .authorizeHttpRequests(authorize -> authorize
                .requestMatchers("/public/**").permitAll()
                .anyRequest().authenticated()
            )
            .oauth2ResourceServer(oauth2 -> oauth2
                .jwt(jwt -> jwt
                    .decoder(multiIssuerDecoder())
                )
            );

        return http.build();
    }

    @Bean
    public JwtDecoder multiIssuerDecoder() {
        Map<String, JwtDecoder> issuerDecoders = new HashMap<>();

        // Configure primary issuer decoder
        JwtDecoder primaryDecoder = NimbusJwtDecoder.withJwkSetUri(primaryJwkSetUri).build();
        issuerDecoders.put(primaryIssuerUri, primaryDecoder);

        // Configure secondary issuer decoder
        JwtDecoder secondaryDecoder = NimbusJwtDecoder.withJwkSetUri(secondaryJwkSetUri).build();
        issuerDecoders.put(secondaryIssuerUri, secondaryDecoder);

        return token -> {
            // Parse the token to extract the issuer claim
            Jwt jwt = JwtHelper.decode(token.getTokenValue());
            Map<String, Object> claims = new ObjectMapper().readValue(jwt.getClaims(), Map.class);

            String issuer = (String) claims.get("iss");
            if (issuer == null) {
                throw new JwtException("Missing issuer claim");
            }

            // Select the appropriate decoder based on the issuer
            JwtDecoder decoder = issuerDecoders.get(issuer);
            if (decoder == null) {
                throw new JwtException("Unknown issuer: " + issuer);
            }

            return decoder.decode(token.getTokenValue());
        };
    }
}
```

Update your `application.yml` to include the secondary issuer:

```yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://primary-auth-server.com
          jwk-set-uri: https://primary-auth-server.com/.well-known/jwks.json

custom:
  security:
    oauth2:
      resourceserver:
        jwt:
          secondary-issuer-uri: https://secondary-auth-server.com
          secondary-jwk-set-uri: https://secondary-auth-server.com/.well-known/jwks.json
```

## Improved Implementation after Spring Boot 3.5.0

Spring Boot 3.5.0 introduces better support for handling multiple issuers. Let's improve our implementation:

```java
@Configuration
@EnableWebSecurity
public class ImprovedMultipleResourceServerConfig {

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
            .authorizeHttpRequests(authorize -> authorize
                .requestMatchers("/public/**").permitAll()
                .anyRequest().authenticated()
            )
            .oauth2ResourceServer(oauth2 -> oauth2
                .jwt(jwt -> jwt
                    .decoder(issuerBasedJwtDecoder())
                )
            );

        return http.build();
    }

    @Bean
    public JwtDecoder issuerBasedJwtDecoder() {
        // Create a map of issuer URIs to their respective JWK set URIs
        Map<String, String> issuerJwkSetUris = Map.of(
            "https://primary-auth-server.com", "https://primary-auth-server.com/.well-known/jwks.json",
            "https://secondary-auth-server.com", "https://secondary-auth-server.com/.well-known/jwks.json"
        );

        // Create a JwtDecoderProviderManager with a list of providers
        List<JwtDecoderProvider> providers = new ArrayList<>();

        for (Map.Entry<String, String> entry : issuerJwkSetUris.entrySet()) {
            String issuerUri = entry.getKey();
            String jwkSetUri = entry.getValue();

            // Create a provider for each issuer
            providers.add(token -> {
                try {
                    // Extract the issuer claim without fully validating the token
                    Jwt jwt = JwtHelper.decode(token.getTokenValue());
                    Map<String, Object> claims = new ObjectMapper().readValue(jwt.getClaims(), Map.class);

                    String tokenIssuer = (String) claims.get("iss");

                    // If this provider handles this issuer, create and return a decoder
                    if (issuerUri.equals(tokenIssuer)) {
                        return Optional.of(NimbusJwtDecoder.withJwkSetUri(jwkSetUri)
                            .jwtProcessorCustomizer(processor -> {
                                // Configure the processor to validate the issuer
                                DefaultJWTClaimsVerifier<SecurityContext> verifier = 
                                    new DefaultJWTClaimsVerifier<>(
                                        new JWTClaimsSet.Builder().issuer(issuerUri).build(),
                                        new HashSet<>(Arrays.asList("sub", "iat", "exp", "aud"))
                                    );
                                processor.setJWTClaimsSetVerifier(verifier);
                            })
                            .build());
                    }

                    // This provider doesn't handle this issuer
                    return Optional.empty();
                } catch (Exception e) {
                    return Optional.empty();
                }
            });
        }

        // Create a manager that will try each provider in order
        JwtDecoderProviderManager providerManager = new JwtDecoderProviderManager(providers);

        // Return a decoder that delegates to the provider manager
        return token -> {
            try {
                return providerManager.decode(token);
            } catch (Exception e) {
                throw new JwtException("Unable to decode JWT token: " + e.getMessage(), e);
            }
        };
    }

    // Interface for providers that can optionally decode a token
    interface JwtDecoderProvider {
        Optional<JwtDecoder> provideDecoder(BearerTokenAuthenticationToken token);

        default Jwt decode(BearerTokenAuthenticationToken token) throws JwtException {
            return provideDecoder(token)
                .orElseThrow(() -> new JwtException("No suitable decoder found"))
                .decode(token.getToken());
        }
    }

    // Manager that tries multiple providers
    static class JwtDecoderProviderManager {
        private final List<JwtDecoderProvider> providers;

        JwtDecoderProviderManager(List<JwtDecoderProvider> providers) {
            this.providers = providers;
        }

        public Jwt decode(BearerTokenAuthenticationToken token) throws JwtException {
            for (JwtDecoderProvider provider : providers) {
                Optional<JwtDecoder> decoder = provider.provideDecoder(token);
                if (decoder.isPresent()) {
                    return decoder.get().decode(token.getToken());
                }
            }
            throw new JwtException("No suitable issuer found in JWT token");
        }
    }
}
```

## Using JWK Sets for Signature Verification

The JWK (JSON Web Key) set is a set of keys containing the public keys that should be used to verify the JWT signature. Each issuer provides its own JWK set, typically at a well-known URL endpoint.

When our application receives a JWT, it needs to:

1. Extract the issuer claim from the token
2. Determine which JWK set to use based on the issuer
3. Verify the token's signature using the appropriate key from that JWK set

Spring Security's `NimbusJwtDecoder` handles the JWK retrieval and caching for us, but we need to configure it with the correct JWK set URI for each issuer.

### Understanding the JWK Set Endpoint

A JWK set is typically available at a standard endpoint like `/.well-known/jwks.json` or `/certs`. The response is a JSON object containing an array of JWK objects:

```json
{
  "keys": [
    {
      "kty": "RSA",
      "kid": "key-id-1",
      "use": "sig",
      "alg": "RS256",
      "n": "base64-encoded-modulus",
      "e": "base64-encoded-exponent"
    },
    {
      "kty": "RSA",
      "kid": "key-id-2",
      "use": "sig",
      "alg": "RS256",
      "n": "another-base64-encoded-modulus",
      "e": "another-base64-encoded-exponent"
    }
  ]
}
```

Each key in the set has a unique identifier (`kid`), which is included in the JWT header. This allows the verifier to select the correct key from the set when verifying the token's signature.

## Handling Token Validation

When validating a JWT, we need to check several things:

1. **Signature**: Verify that the token was signed by the expected issuer
2. **Expiration**: Check that the token hasn't expired
3. **Issuer**: Confirm the token was issued by a trusted issuer
4. **Audience**: Verify the token is intended for our application
5. **Other claims**: Validate any additional claims required by your application

Spring Security's JWT support handles most of these checks automatically, but we need to configure it correctly for each issuer.

### Example Controller

Here's an example controller that uses the authenticated principal:

```java
@RestController
public class ResourceController {

    @GetMapping("/resource")
    public Map<String, Object> resource(JwtAuthenticationToken principal) {
        Map<String, Object> response = new HashMap<>();
        response.put("resource", "Protected Resource");
        response.put("principal", principal.getName());
        response.put("authorities", principal.getAuthorities().stream()
            .map(GrantedAuthority::getAuthority)
            .collect(Collectors.toList()));
        response.put("token_claims", principal.getToken().getClaims());
        response.put("token_issuer", principal.getToken().getClaimAsString("iss"));

        return response;
    }

    @GetMapping("/public/info")
    public Map<String, String> publicInfo() {
        Map<String, String> response = new HashMap<>();
        response.put("message", "This is a public endpoint");
        return response;
    }
}
```

## Testing the Configuration

To test our configuration, we need tokens from both issuers. Here's a simple test class:

```java
@SpringBootTest
@AutoConfigureMockMvc
public class MultipleResourceServerTests {

    @Autowired
    private MockMvc mockMvc;

    @Test
    public void accessProtectedResourceWithPrimaryIssuerToken() throws Exception {
        String primaryToken = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..."; // Valid token from primary issuer

        mockMvc.perform(get("/resource")
                .header("Authorization", "Bearer " + primaryToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.token_issuer").value("https://primary-auth-server.com"));
    }

    @Test
    public void accessProtectedResourceWithSecondaryIssuerToken() throws Exception {
        String secondaryToken = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..."; // Valid token from secondary issuer

        mockMvc.perform(get("/resource")
                .header("Authorization", "Bearer " + secondaryToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.token_issuer").value("https://secondary-auth-server.com"));
    }

    @Test
    public void accessPublicEndpointWithoutToken() throws Exception {
        mockMvc.perform(get("/public/info"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.message").value("This is a public endpoint"));
    }

    @Test
    public void accessProtectedResourceWithInvalidToken() throws Exception {
        String invalidToken = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..."; // Invalid or expired token

        mockMvc.perform(get("/resource")
                .header("Authorization", "Bearer " + invalidToken))
                .andExpect(status().isUnauthorized());
    }
}
```

# Advanced Configuration

## Custom Authentication Converter

You can customize how JWT claims are converted to authorities:

```java
@Bean
public JwtAuthenticationConverter jwtAuthenticationConverter() {
    JwtGrantedAuthoritiesConverter grantedAuthoritiesConverter = new JwtGrantedAuthoritiesConverter();
    grantedAuthoritiesConverter.setAuthoritiesClaimName("roles");
    grantedAuthoritiesConverter.setAuthorityPrefix("ROLE_");

    JwtAuthenticationConverter jwtAuthenticationConverter = new JwtAuthenticationConverter();
    jwtAuthenticationConverter.setJwtGrantedAuthoritiesConverter(grantedAuthoritiesConverter);

    return jwtAuthenticationConverter;
}
```

Then add it to your security configuration:

```java
@Bean
public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
    http
        .authorizeHttpRequests(authorize -> authorize
            .requestMatchers("/public/**").permitAll()
            .anyRequest().authenticated()
        )
        .oauth2ResourceServer(oauth2 -> oauth2
            .jwt(jwt -> jwt
                .decoder(issuerBasedJwtDecoder())
                .jwtAuthenticationConverter(jwtAuthenticationConverter())
            )
        );

    return http.build();
}
```

## Handling Different Claim Structures

Different authorization servers might use different claim structures. You can handle this by customizing the authentication converter for each issuer:

```java
@Bean
public JwtDecoder issuerBasedJwtDecoder() {
    Map<String, JwtDecoder> issuerDecoders = new HashMap<>();

    // Primary issuer uses standard claims
    JwtDecoder primaryDecoder = NimbusJwtDecoder.withJwkSetUri("https://primary-auth-server.com/.well-known/jwks.json").build();

    // Secondary issuer uses custom claims
    NimbusJwtDecoder secondaryDecoder = NimbusJwtDecoder.withJwkSetUri("https://secondary-auth-server.com/.well-known/jwks.json").build();
    secondaryDecoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(
        new JwtTimestampValidator(),
        new JwtIssuerValidator("https://secondary-auth-server.com"),
        token -> {
            // Custom validation for secondary issuer
            Map<String, Object> claims = token.getClaims();
            if (!claims.containsKey("custom_claim")) {
                return OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token", "Missing custom claim", null));
            }
            return OAuth2TokenValidatorResult.success();
        }
    ));

    issuerDecoders.put("https://primary-auth-server.com", primaryDecoder);
    issuerDecoders.put("https://secondary-auth-server.com", secondaryDecoder);

    return token -> {
        try {
            // Extract the issuer claim
            Jwt jwt = JwtHelper.decode(token.getTokenValue());
            Map<String, Object> claims = new ObjectMapper().readValue(jwt.getClaims(), Map.class);

            String issuer = (String) claims.get("iss");
            if (issuer == null) {
                throw new JwtException("Missing issuer claim");
            }

            // Select the appropriate decoder
            JwtDecoder decoder = issuerDecoders.get(issuer);
            if (decoder == null) {
                throw new JwtException("Unknown issuer: " + issuer);
            }

            return decoder.decode(token.getTokenValue());
        } catch (Exception e) {
            throw new JwtException("Failed to decode JWT: " + e.getMessage(), e);
        }
    };
}
```

# Summary

Spring Boot 3.5.0 provides powerful tools for handling multiple OAuth2 Resource Servers in a single application. By creating a custom `JwtDecoder` that selects the appropriate validation logic based on the token's issuer, we can securely validate tokens from different authorization servers.

Key points to remember:

1. Use a custom `JwtDecoder` to handle tokens from multiple issuers
2. Configure each issuer with its own JWK set URI for signature verification
3. Validate the token's claims according to each issuer's requirements
4. Consider using custom authentication converters if issuers use different claim structures
5. Always validate the token's signature, expiration, issuer, and audience

With this approach, your Spring Boot application can seamlessly integrate with multiple OAuth2 ecosystems, providing flexibility and security for your microservices architecture.

[spring-security-docs]: https://docs.spring.io/spring-security/reference/servlet/oauth2/resource-server/index.html
[jwt-spec]: https://datatracker.ietf.org/doc/html/rfc7519
[jwk-spec]: https://datatracker.ietf.org/doc/html/rfc7517
