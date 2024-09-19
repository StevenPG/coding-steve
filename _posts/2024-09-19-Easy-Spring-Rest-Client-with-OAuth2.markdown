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

Structure:

- overview of oauth2

- note about updating on release
- webclient in latest spring boot

## The Setup (Currently a Milestone Release but this will be updated!)

Here's everything you need to get RestClient working with OAuth2!

build.gradle
```groovy
plugins {
    id 'org.springframework.boot' version '3.3.3'

...

implementation 'org.springframework.boot:spring-boot-starter-actuator'
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

ConfigurationClass.java
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

[soby-chako]: https://github.com/sobychacko
