---
author: StevenPG
pubDatetime: 2025-06-02T12:00:00.000Z
title: Dynamically setting audience for using Spring OAuth2 Client
slug: spring-oauth2-client-dynamic-audience
featured: false
draft: true

ogImage: https://i.imgur.com/4ICZldG.jpeg
tags:
  - software
  - spring boot
  - java
  - oauth
description: An article walking through a demo of dynamically setting a query parameter using spring-oauth2-client.
---

## Table of Contents

[[toc]]

# Brief

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things
that caused me trouble. That way, if this is found, someone doesn't have to do the same digging I had to do.

This post DOES assume you have a basic understanding of OAuth2 and Spring Security around classes and concepts like ClientRegistrations and AuthorizationGrantType.

If you're missing that, go do a sample project of basic OAuth2 and come back later!

# What is OAuth2?

OAuth2 is a popular authorization framework that allows users to grant
third-party applications access to their data without revealing their
credentials. It's often used for services like social media logins, API integrations, and more.

Tokens used in the OAuth2 process have required and optional claims. These claims are simple fields that are validated by the receiver of the token as defined in
https://datatracker.ietf.org/doc/html/rfc7519#section-4.1.3. 

One of these claims is the "aud" claim, or the audience claim.

The "aud" (audience) claim identifies the recipients that the JWT is intended for and principal that intends to process the JWT must identify itself with a value in the audience claim; otherwise, the JWT must be rejected. The "aud" value is typically an array of case-sensitive strings, each containing a StringOrURI value, though it can also be a single case-sensitive string when there is only one audience. The interpretation of audience values is generally application-specific, and the use of this claim is optional. This is all for defense against "replay attacks", where a token is re-used to call a different target once it's stolen from the initial request.

## Why do I care?

In most systems, these audience claims are set by the OAuth2 provider. For example, if you have a client configured for your application that calls server-a,
the oauth2 server might set every user of that client to automatically set the audience to `"aud": "server-a". This means a client like Spring's oauth2-client
has no reason to care about the audience on the token.

However, there is an uncommon scenario where a federated set of systems may need to dynamically set the audience claim. This is usually done by allowing some
sort of query_parameter on the token request. For example; providing an `intended_audience=my-target-server` query parameter. This would inform the oauth server
to set the audience claim to `"aud": "my-target-server"`.

## Spring Security - Component Model

The main goal of this article is to have a single source of information for setting up custom Client Credentials Provider in Spring Security. The example in this post will be dynamically setting the "aud" claim based on the target host.

TODO - diagram of the pieces

### Setting up our Overrides

Many of these classes are final, so to implement our functionality, we're going to create sibling classes and inject them into the Spring Security management layer so that we can control our token requests!

We set up the initial configuration in a `RestClientConfiguration` class

TODO - finalize with comments and cleanup
```java
@Configuration
public class RestClientConfiguration
{

    @Bean
    public OAuth2AuthorizedClientManager authorizedClientManager (
            ClientRegistrationRepository clientRegistrationRepository,
            OAuth2AuthorizedClientService authorizedClientService,
            AudienceWritingOAuth2AccessTokenResponseClient accessTokenResponseClient
    ){
        // We create a manager using the autowired clientRegistrations from YAML and connect it to the service
        AudienceWritingAuthorizedClientServiceOAuth2AuthorizedClientManager authorizedClientManager =
                new AudienceWritingAuthorizedClientServiceOAuth2AuthorizedClientManager(clientRegistrationRepository, authorizedClientService);

        // Setting the clientManager to look for a clientCredentials configuration
        authorizedClientManager.setAuthorizedClientProvider(new AudienceWritingClientCredentialsOAuth2AuthorizedClientProvider());
//        authorizedClientManager.setAuthorizedClientProvider(OAuth2AuthorizedClientProviderBuilder.builder()
//                        .clientCredentials(clientCredentialsGrantBuilder ->
//                                clientCredentialsGrantBuilder.accessTokenResponseClient(accessTokenResponseClient))
//                .clientCredentials()
//                .build());

        // This customizer is crucial for passing RestClient attributes to the OAuth2AuthorizeRequest
        authorizedClientManager.setContextAttributesMapper(authorizeRequest -> {
            // The OAuth2AuthorizedClientInterceptor automatically copies RestClient's
            // attributes into the OAuth2AuthorizeRequest's attributes.
            // So, we just return the existing attributes.
            return new HashMap<>(authorizeRequest.getAttributes());
        });

        return authorizedClientManager;
    }

    @Bean
    public RestClient oauth2RestClient(
            OAuth2AuthorizedClientManager authorizedClientManager) {

        // This is the new class!
        // We instantiate a new interceptor to load into RestClient
        AudienceWritingOAuth2ClientHttpRequestInterceptor oAuth2ClientHttpRequestInterceptor =
                new AudienceWritingOAuth2ClientHttpRequestInterceptor(authorizedClientManager);
        // Then provide it the client registration to resolve the id from

        // From here we simply return the client with any custom configuration, and we're good to go!
        return RestClient.builder()
                .baseUrl("https://httpbin.org/headers")
                .requestInterceptor(oAuth2ClientHttpRequestInterceptor)
                .build();
    }
}
```

### The Classes at Play

With our initial configuration, the following classes are what we're going to be either extending or overwriting. Our overridden versions will be included below this section:

Please note: This is focusing on the ClientCredentials grant type for OAuth2. The other types are
similar but may have different classes or class hierarchy.

#### AuthorizedClientServiceOAuth2AuthorizedClientManager

This manager contains the overall configuration and bootstrapping of the token retrieving operation
that executes automagically before RestClient requests that are configured to utilize it.

The bean we define in the `RestClientConfiguration` returns an OAuth2AuthorizedClientManager, with the
referenced class here being just one example. This bean is then used to instantiate the RestClient's
ClientHttpRequestInterceptor.

https://github.com/spring-projects/spring-security/blob/6.5.0/oauth2/oauth2-client/src/main/java/org/springframework/security/oauth2/client/AuthorizedClientServiceOAuth2AuthorizedClientManager.java

#### ClientCredentialsOAuth2AuthorizedClientProvider

OAuth2AuthorizedClientProvider implementations attempt to authorize or re-authorize the configured ClientRegistration. It contains a context object that maintains the relevant information for performing
the aforementioned authorizaton or re-authorizations.

https://github.com/spring-projects/spring-security/blob/6.5.0/oauth2/oauth2-client/src/main/java/org/springframework/security/oauth2/client/ClientCredentialsOAuth2AuthorizedClientProvider.java

#### OAuth2ClientHttpRequestInterceptor

This is a new class that provides an easy mechanism for using an OAuth2AuthorizedClient to make requests
by automatically injecting a bearer token for OAuth2 requests. It is defined in our `RestClientConfiguration` above.

https://github.com/spring-projects/spring-security/blob/6.5.0/oauth2/oauth2-client/src/main/java/org/springframework/security/oauth2/client/web/client/OAuth2ClientHttpRequestInterceptor.java

#### OAuth2ClientCredentialsGrantRequest

This object contains the client credentials and other client registration details relevant for querying
for a new token.

https://github.com/spring-projects/spring-security/blob/6.5.0/oauth2/oauth2-client/src/main/java/org/springframework/security/oauth2/client/endpoint/OAuth2ClientCredentialsGrantRequest.java

#### OAuth2AccessTokenResponseClient

This class performs the actual exchange for an access token at the authorization server's token endpoint. This parent class is implemented based on the underlying oauth2 type. In this post, we'll
be overriding the ClientCredentials implementation of a TokenResponseClient.

https://github.com/spring-projects/spring-security/blob/6.5.0/oauth2/oauth2-client/src/main/java/org/springframework/security/oauth2/client/endpoint/OAuth2AccessTokenResponseClient.java

### Overriding and Injecting

#### AudienceWritingAuthorizedClientServiceOAuth2AuthorizedClientManager

In our version of this class, we're going to implement the base OAuth2AuthorizedClientManager class. 

TODO - add comments
```java
public class AudienceWritingAuthorizedClientServiceOAuth2AuthorizedClientManager implements OAuth2AuthorizedClientManager {
    private static final OAuth2AuthorizedClientProvider DEFAULT_AUTHORIZED_CLIENT_PROVIDER = OAuth2AuthorizedClientProviderBuilder
            .builder()
            .clientCredentials()
            .build();

    private final ClientRegistrationRepository clientRegistrationRepository;
    private final OAuth2AuthorizedClientService authorizedClientService;
    private OAuth2AuthorizedClientProvider authorizedClientProvider;
    private Function<OAuth2AuthorizeRequest, Map<String, Object>> contextAttributesMapper;
    private OAuth2AuthorizationSuccessHandler authorizationSuccessHandler;
    private OAuth2AuthorizationFailureHandler authorizationFailureHandler;

    /**
     * Constructs an {@code AuthorizedClientServiceOAuth2AuthorizedClientManager} using
     * the provided parameters.
     * @param clientRegistrationRepository the repository of client registrations
     * @param authorizedClientService the authorized client service
     */
    public AudienceWritingAuthorizedClientServiceOAuth2AuthorizedClientManager(
            ClientRegistrationRepository clientRegistrationRepository,
            OAuth2AuthorizedClientService authorizedClientService) {
        Assert.notNull(clientRegistrationRepository, "clientRegistrationRepository cannot be null");
        Assert.notNull(authorizedClientService, "authorizedClientService cannot be null");
        this.clientRegistrationRepository = clientRegistrationRepository;
        this.authorizedClientService = authorizedClientService;
        this.authorizedClientProvider = DEFAULT_AUTHORIZED_CLIENT_PROVIDER;
        this.contextAttributesMapper = new AuthorizedClientServiceOAuth2AuthorizedClientManager.DefaultContextAttributesMapper();
        this.authorizationSuccessHandler = (authorizedClient, principal, attributes) -> authorizedClientService
                .saveAuthorizedClient(authorizedClient, principal);
        this.authorizationFailureHandler = new RemoveAuthorizedClientOAuth2AuthorizationFailureHandler(
                (clientRegistrationId, principal, attributes) -> authorizedClientService
                        .removeAuthorizedClient(clientRegistrationId, principal.getName()));
    }

    @Nullable
    @Override
    public OAuth2AuthorizedClient authorize(OAuth2AuthorizeRequest authorizeRequest) {
        Assert.notNull(authorizeRequest, "authorizeRequest cannot be null");
        String clientRegistrationId = authorizeRequest.getClientRegistrationId();
        OAuth2AuthorizedClient authorizedClient = authorizeRequest.getAuthorizedClient();
        Authentication principal = authorizeRequest.getPrincipal();
        OAuth2AuthorizationContext.Builder contextBuilder;
        if (authorizedClient != null) {
            contextBuilder = OAuth2AuthorizationContext.withAuthorizedClient(authorizedClient);
        }
        else {
            ClientRegistration clientRegistration = this.clientRegistrationRepository
                    .findByRegistrationId(clientRegistrationId);
            Assert.notNull(clientRegistration,
                    "Could not find ClientRegistration with id '" + clientRegistrationId + "'");
            authorizedClient = this.authorizedClientService.loadAuthorizedClient(clientRegistrationId,
                    principal.getName());
            if (authorizedClient != null) {
                contextBuilder = OAuth2AuthorizationContext.withAuthorizedClient(authorizedClient);
            }
            else {
                contextBuilder = OAuth2AuthorizationContext.withClientRegistration(clientRegistration);
            }
        }
        OAuth2AuthorizationContext authorizationContext = buildAuthorizationContext(authorizeRequest, principal,
                contextBuilder);
        try {
            authorizedClient = this.authorizedClientProvider.authorize(authorizationContext);
        }
        catch (OAuth2AuthorizationException ex) {
            this.authorizationFailureHandler.onAuthorizationFailure(ex, principal, Collections.emptyMap());
            throw ex;
        }
        if (authorizedClient != null) {
            this.authorizationSuccessHandler.onAuthorizationSuccess(authorizedClient, principal,
                    Collections.emptyMap());
        }
        else {
            // In the case of re-authorization, the returned `authorizedClient` may be
            // null if re-authorization is not supported.
            // For these cases, return the provided
            // `authorizationContext.authorizedClient`.
            if (authorizationContext.getAuthorizedClient() != null) {
                return authorizationContext.getAuthorizedClient();
            }
        }
        return authorizedClient;
    }

    private OAuth2AuthorizationContext buildAuthorizationContext(OAuth2AuthorizeRequest authorizeRequest,
                                                                 Authentication principal, OAuth2AuthorizationContext.Builder contextBuilder) {
        // @formatter:off
        return contextBuilder.principal(principal)
                .attributes((attributes) -> {
                    Map<String, Object> contextAttributes = this.contextAttributesMapper.apply(authorizeRequest);
                    if (!CollectionUtils.isEmpty(contextAttributes)) {
                        attributes.putAll(contextAttributes);
                    }
                })
                .build();
        // @formatter:on
    }

    /**
     * Sets the {@link OAuth2AuthorizedClientProvider} used for authorizing (or
     * re-authorizing) an OAuth 2.0 Client.
     * @param authorizedClientProvider the {@link OAuth2AuthorizedClientProvider} used for
     * authorizing (or re-authorizing) an OAuth 2.0 Client
     */
    public void setAuthorizedClientProvider(OAuth2AuthorizedClientProvider authorizedClientProvider) {
        Assert.notNull(authorizedClientProvider, "authorizedClientProvider cannot be null");
        this.authorizedClientProvider = authorizedClientProvider;
    }

    /**
     * Sets the {@code Function} used for mapping attribute(s) from the
     * {@link OAuth2AuthorizeRequest} to a {@code Map} of attributes to be associated to
     * the {@link OAuth2AuthorizationContext#getAttributes() authorization context}.
     * @param contextAttributesMapper the {@code Function} used for supplying the
     * {@code Map} of attributes to the {@link OAuth2AuthorizationContext#getAttributes()
     * authorization context}
     */
    public void setContextAttributesMapper(
            Function<OAuth2AuthorizeRequest, Map<String, Object>> contextAttributesMapper) {
        Assert.notNull(contextAttributesMapper, "contextAttributesMapper cannot be null");
        this.contextAttributesMapper = contextAttributesMapper;
    }

}
```

#### AudienceWritingClientCredentialsOAuth2AuthorizedClientProvider

OAuth2AuthorizedClientProvider implementations attempt to authorize or re-authorize the configured ClientRegistration. It contains a context object that maintains the relevant information for performing
the aforementioned authorizaton or re-authorizations.

TODO - comments
```java
public class AudienceWritingClientCredentialsOAuth2AuthorizedClientProvider implements OAuth2AuthorizedClientProvider {

    private AudienceWritingOAuth2AccessTokenResponseClient accessTokenResponseClient = new AudienceWritingOAuth2AccessTokenResponseClient();

    private Duration clockSkew = Duration.ofSeconds(60);

    private Clock clock = Clock.systemUTC();

    /**
     * Attempt to authorize (or re-authorize) the
     * {@link OAuth2AuthorizationContext#getClientRegistration() client} in the provided
     * {@code context}. Returns {@code null} if authorization (or re-authorization) is not
     * supported, e.g. the client's {@link ClientRegistration#getAuthorizationGrantType()
     * authorization grant type} is not {@link AuthorizationGrantType#CLIENT_CREDENTIALS
     * client_credentials} OR the {@link OAuth2AuthorizedClient#getAccessToken() access
     * token} is not expired.
     * @param context the context that holds authorization-specific state for the client
     * @return the {@link OAuth2AuthorizedClient} or {@code null} if authorization (or
     * re-authorization) is not supported
     */
    @Override
    @Nullable
    public OAuth2AuthorizedClient authorize(OAuth2AuthorizationContext context) {
        Assert.notNull(context, "context cannot be null");
        ClientRegistration clientRegistration = context.getClientRegistration();
        if (!AuthorizationGrantType.CLIENT_CREDENTIALS.equals(clientRegistration.getAuthorizationGrantType())) {
            return null;
        }
        OAuth2AuthorizedClient authorizedClient = context.getAuthorizedClient();
        if (authorizedClient != null && !hasTokenExpired(authorizedClient.getAccessToken())) {
            // If client is already authorized but access token is NOT expired than no
            // need for re-authorization
            return null;
        }
        // As per spec, in section 4.4.3 Access Token Response
        // https://tools.ietf.org/html/rfc6749#section-4.4.3
        // A refresh token SHOULD NOT be included.
        //
        // Therefore, renewing an expired access token (re-authorization)
        // is the same as acquiring a new access token (authorization).
        OAuth2ClientCredentialsAudiencedGrantRequest clientCredentialsGrantRequest = new OAuth2ClientCredentialsAudiencedGrantRequest(
                clientRegistration, context.getAttribute("audience"));
        OAuth2AccessTokenResponse tokenResponse = getTokenResponse(clientRegistration, clientCredentialsGrantRequest);
        return new OAuth2AuthorizedClient(clientRegistration, context.getPrincipal().getName(),
                tokenResponse.getAccessToken());
    }

    private OAuth2AccessTokenResponse getTokenResponse(ClientRegistration clientRegistration,
                                                       OAuth2ClientCredentialsAudiencedGrantRequest clientCredentialsGrantRequest) {
        try {
            return this.accessTokenResponseClient.getTokenResponse(clientCredentialsGrantRequest);
        }
        catch (OAuth2AuthorizationException ex) {
            throw new ClientAuthorizationException(ex.getError(), clientRegistration.getRegistrationId(), ex);
        }
    }

    private boolean hasTokenExpired(OAuth2Token token) {
        return this.clock.instant().isAfter(token.getExpiresAt().minus(this.clockSkew));
    }

}
```

#### OAuth2ClientHttpRequestInterceptor

This is a new class that provides an easy mechanism for using an OAuth2AuthorizedClient to make requests
by automatically injecting a bearer token for OAuth2 requests. It is defined in our `RestClientConfiguration` above.

#### OAuth2ClientCredentialsGrantRequest

This object contains the client credentials and other client registration details relevant for querying
for a new token.

#### OAuth2AccessTokenResponseClient

This class performs the actual exchange for an access token at the authorization server's token endpoint. This parent class is implemented based on the underlying oauth2 type. In this post, we'll
be overriding the ClientCredentials implementation of a TokenResponseClient.

TODO

- lay out diagram of classes with descriptions in diagram
- lay out individual classes
- link to public Github with example, add in readme of how to set up keycloak

[github]: https://github.com
