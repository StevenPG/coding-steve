---
layout: post
title:  "Easy Spring Rest Client w/ OAuth2"
toc: true
date: 2024-09-19 12:00:00 -0500
categories:
- software
- spring boot
- java
---

# Brief

My goal is to make posts like this to SIMPLEST place on the internet to learn how to do things
that caused me trouble. That way, if this is found, someone doesn't have to do the same digging I had to do.

# What is OAuth2?

OAuth2 is a popular authorization framework that allows users to grant 
third-party applications access to their data without revealing their 
credentials. It's often used for services like social media logins, API integrations, and more.

### Key Components of OAuth2

- Authorization Server: Issues access tokens to clients after user authorization.
- Resource Server: Protects resources that can only be accessed with valid access tokens.
- Client: The application requesting access to resources.
- User: The person granting or denying access.

### How OAuth2 Works

- User Authorization: The user grants permission to the client to access specific resources.
- Token Exchange: The client exchanges an authorization code for an access token.
- Resource Access: The client uses the access token to access protected resources.

### Why RestClient?

While **RestTemplate** has been a staple for many years, its limitations and the 
introduction of more modern alternatives have led to its deprecation in recent 
versions of Spring Boot. Let's delve into the key differences between WebClient 
and RestClient and why RestTemplate is being phased out.

**WebClient** is built on top of Project Reactor, a reactive
programming framework. This means it can handle asynchronous operations efficiently, 
making it well-suited for scenarios where concurrent requests and non-blocking I/O 
are essential.

However, with RestTemplate's deprecation, the only real Spring alternative is WebClient.
This requires including the spring-webflux dependencies and calling `.block()` when making
blocking API calls. It feels shoe-horned into place.

In comes RestClient, a client written in the same functional style as WebClient, but supports
synchronous and asynchronous out of the box. This lets us remove the spring-webflux
dependency and use spring-web-mvc as the primary HTTP dependency for server and client applications.

## The Setup (Currently a Milestone Release but this will be updated!)

Here's everything you need to get RestClient working with OAuth2!

build.gradle
```groovy
plugins {
    id 'org.springframework.boot' version '3.3.3'

...

implementation 'org.springframework.boot:spring-boot-starter-security'
implementation 'org.springframework.boot:spring-boot-starter-web'
implementation 'org.springframework.security:spring-security-oauth2-client:6.4.0-M3'
```

application.yaml
```yaml
spring:
  security:
    oauth2:
      client:
        registration:
          my-oauth-client:
            client-id: ${oauthClientId}
            client-secret: ${oauthClientSecret}
            provider: my-oauth-provider
            authorization-grant-type: client_credentials
            scope: openid
        provider:
          my-oauth-provider:
            token-uri: ${oauth2ServerUri}/protocol/openid-connect/token
            issuer-uri: ${oauth2ServerUri}
```

application-local.yaml
```yaml
oauth2ServerUri: http://myServerUri:9090
oauthClientId: clientId
oauth2ClientSecret: mySecretSecret
```

RestClientConfiguration.java
```java
@Configuration
public class RestClientConfiguration
{
    // This needs to match the YAML configuration
    private static final String CLIENT_REGISTRATION_ID = "my-oauth-client";

    @Bean
    public OAuth2AuthorizedClientManager authorizedClientManager (
        ClientRegistrationRepository clientRegistrationRepository,
        OAuth2AuthorizedClientService authorizedClientService
    ){
        // We create a manager using the autowired clientRegistrations from YAML and connect it to the service
        AuthorizedClientServiceOAuth2AuthorizedClientManager authorizedClientManager =
            new AuthorizedClientServiceOAuth2AuthorizedClientManager(clientRegistrationRepository, authorizedClientService);
        
        // Setting the clientManager to look for a clientCredentials configuration
        authorizedClientManager.setAuthorizedClientProvider(OAuth2AuthorizedClientProviderBuilder.builder()
            .clientCredentials()
            .build());
        return authorizedClientManager;
    }

    @Bean
    public RestClient oauth2RestClient(
        OAuth2AuthorizedClientManager authorizedClientManager,
        LogbookClientHttpRequestInterceptor logbookClientHttpRequestInterceptor) {

        // This is the new class!!! We instantiate a new one and provide it the client registration to match
        OAuth2ClientHttpRequestInterceptor oAuth2ClientHttpRequestInterceptor =
            new OAuth2ClientHttpRequestInterceptor(authorizedClientManager, request -> CLIENT_REGISTRATION_ID);

        // From here we simply return the client with any custom configuration, and we're good to go!
        return RestClient.builder()
            .baseUrl("http://myBaseUrl:8080")
            .requestInterceptor(oAuth2ClientHttpRequestInterceptor)
            .build();
    }
}
```

Bonus: Setting up HttpServiceProxyFactory (not required but useful!)

```java
public interface MyHttpService {

    @PostExchange("api/my/path")
    SomeResponse post(@RequestBody MyPostBody request);
}
```

```java
@Configuration
public class HttpServiceFactory
{
    @Bean
    public MyHttpService getMyHttpService(RestClient oauth2RestClient) {
        // We're simply injecting our restClient into the factory and creating a concrete instance of the interface
        HttpServiceProxyFactory factory = HttpServiceProxyFactory
            .builderFor(RestClientAdapter.create(oauth2RestClient))
            .build();
        return factory.createClient(MyHttpService.class);
    }
}
```

TODO - add links to things

## Summary

The new RestClient is already a popular alternative for developers in the Spring ecosystem. 
The lack of an OAuth2 component has been a sore spot for new users converting over from WebClient. So with
this new feature releasing in Spring Boot 3.4.0, it can now take it's rightful place as the default, non-webflux
HTTP Client for Spring MVC!

[soby-chako]: https://github.com/sobychacko
