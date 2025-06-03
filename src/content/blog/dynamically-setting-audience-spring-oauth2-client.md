---
author: StevenPG
pubDatetime: 2025-06-02T12:00:00.000Z
title: Dynamically setting audience for using Spring OAuth2 Client
slug: spring-oauth2-client-dynamic-audience
featured: true

ogImage: https://i.imgur.com/4ICZldG.jpeg
tags:
  - software
  - spring boot
  - java
  - oauth
description: An article walking through a demo of dynamically setting a query parameter using spring-oauth2-client.
---

TODO

- reference the original oauth2 article
- Give a brief overview of oauth
- Give a brief overview of the audience field and the "aud" claim
- describe the issue and link to intended_audience with google (federated system ex.)
- lay out diagram of classes with descriptions in diagram
- lay out individual classes
- link to public Github with example, add in readme of how to set up keycloak

# Brief

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things
that caused me trouble. That way, if this is found, someone doesn't have to do the same digging I had to do.

# What is OAuth2?

OAuth2 is a popular authorization framework that allows users to grant
third-party applications access to their data without revealing their
credentials. It's often used for services like social media logins, API integrations, and more.

Tokens used in the OAuth2 process have required and optional claims. These claims are simple fields that are validated by the receiver of the token as defined in
https://datatracker.ietf.org/doc/html/rfc7519. One of these claims is the "aud" claim, or the audience claim.

The "aud" (audience) claim identifies the recipients that the JWT is intended for and principal that intends to process the JWT must identify itself with a value in the audience claim; otherwise, the JWT must be rejected. The "aud" value is typically an array of case-sensitive strings, each containing a StringOrURI value, though it can also be a single case-sensitive string when there is only one audience. The interpretation of audience values is generally application-specific, and the use of this claim is optional. This is all for defense against "replay attacks", where a token is re-used to call a different target once it's stolen from the initial request.

## Why do I care?

In most systems, these audience claims are set by the OAuth2 provider. For example, if you have a client configured for your application that calls server-a,
the oauth2 server might set every user of that client to automatically set the audience to `"aud": "server-a". This means a client like Spring's oauth2-client
has no reason to care about the audience on the token.

However, there is an uncommon scenario where a federated set of systems may need to dynamically set the audience claim. This is usually done by allowing some
sort of query_parameter on the token request. For example;

TODO - insert google inteded_audience

### Spring RestClient

I wrote a previous post on Spring's "new" RestClient, available here: https://stevenpg.com/posts/spring-rest-client-oauth2/

The classes used are different based on the HttpClient being used, but for this article I'm using RestClient!

-----

### Why RestClient?

While **RestTemplate** has been a staple for many years, its limitations and the
introduction of more modern alternatives have led to its deprecation in recent
versions of Spring. Let's dive into the key differences between WebClient
and RestClient and why RestTemplate is being phased out.

**WebClient** is built on top of Project Reactor, a reactive
programming framework. This means it can handle asynchronous operations efficiently,
making it well-suited for scenarios where concurrent requests and non-blocking I/O
are essential.

However, with RestTemplate's deprecation, the only real Spring alternative is WebClient.
This requires including the spring-webflux dependencies and calling `.block()` when making
blocking API calls. It feels shoe-horned into place.

In comes [RestClient][restClientBlogAnnouncement], a client written in the same functional style as WebClient, but supports
synchronous and asynchronous operations out of the box. This lets us remove the spring-webflux
dependency and use spring-web-mvc as the primary HTTP dependency for server and client applications.

## The Setup (Currently a Milestone Release but this will be updated!)

Here's everything you need to get RestClient working with OAuth2!

build.gradle
```groovy
plugins {
    id 'org.springframework.boot' version '3.3.3'
}

    // ... The rest of the stuff, this is just what's required

    dependencies {
        implementation 'org.springframework.boot:spring-boot-starter-security'
        implementation 'org.springframework.boot:spring-boot-starter-web'
        implementation 'org.springframework.security:spring-security-oauth2-client:6.4.0-M3'
    }
}
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

RestClientConfiguration.java using the new [OAuth2ClientHttpRequestInterceptor][oAuth2ClientHttpRequestInterceptor]
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
        OAuth2AuthorizedClientManager authorizedClientManager) {

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

### Bonus: Setting up HttpServiceProxyFactory (not required but useful!)

[HttpServiceProxyFactory][httpServiceProxyFactory] is new in [Spring 6][httpServiceProxyFactoryJavadoc]!

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

## Summary

The new RestClient is already a popular alternative for developers in the Spring ecosystem.
The lack of an OAuth2 component has been a sore spot for new users converting over from WebClient. So with
this new feature releasing in Spring Boot 3.4.0, it can now take it's rightful place as the default, non-webflux
HTTP Client for Spring MVC!

## Update Note

Once this is available in the official spring release, I'll update this from milestone versions and
hook up the JavaDoc instead of the originating Github Issue!

[restClientBlogAnnouncement]: https://spring.io/blog/2023/07/13/new-in-spring-6-1-restclient
[oAuth2ClientHttpRequestInterceptor]: https://github.com/spring-projects/spring-security/issues/13588
[httpServiceProxyFactoryJavadoc]: https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/web/service/invoker/HttpServiceProxyFactory.html
[httpServiceProxyFactory]: https://www.baeldung.com/spring-6-http-interface
[soby-chako]: https://github.com/sobychacko