---
author: StevenPG
pubDatetime: 2026-07-20T00:00:00.000Z
title: "The Ultimate Guide to Spring Security 7 (Migrating from 6)"
slug: ultimate-guide-spring-security-7-migration
featured: true
ogImage: /assets/default-og-image.png
tags:
  - software
  - java
  - spring boot
  - spring security
  - security
  - oauth2
description: A comprehensive, practical guide to migrating from Spring Security 6 to 7 — the mandatory Lambda DSL, PathPatternRequestMatcher, AuthorizationManager, Jackson 3, OAuth2 and SAML changes, passkeys, and a full upgrade checklist.
---

# The Ultimate Guide to Spring Security 7 (Migrating from 6)

## Table of Contents

[[toc]]

## Introduction

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. Spring Security 7.0 GA shipped in November 2025 alongside Spring Framework 7 and Spring Boot 4, and if you're upgrading a real application, this is the release that finally deletes all the deprecated APIs you've been ignoring the warnings about for years.

The good news: Spring Security 7 is not a rewrite. If you've been keeping up with 6.x and using the Lambda DSL, most of your config already works. The bad news: "most" isn't "all," and several changes are hard removals with no runtime fallback. The `.and()` chaining style is gone. `AntPathRequestMatcher` and `MvcRequestMatcher` are gone. `AccessDecisionManager` is gone. The OAuth2 password grant is gone. If you're on any of those, your app won't start until you fix it.

This guide is for anyone moving a production application or a side project from Spring Security 6.x to 7.0. Everything here is validated against the real 7.0 API. The official [Spring Security migration guide](https://docs.spring.io/spring-security/reference/migration/index.html) is the canonical reference — this post is my attempt at making the practical side of it as painless as possible, with concrete before/after code for every change that matters.

The single most important thing to understand before you start: **Spring Security 6.5 is your migration runway.** It's the last release in the 6.x line, and it exists specifically to let you adopt the 7.0 way of doing things _while still on 6_, with deprecation warnings instead of compile errors. Do not jump straight from 6.2 to 7.0. Go to 6.5 first, get it green, then take the final step.

## Before You Start — Prerequisites

Spring Security 7 doesn't live in isolation. It's pulled in transitively by Spring Boot 4 / Spring Framework 7, and it inherits their baseline requirements.

**Java 21 minimum.** Spring Framework 7 and Spring Boot 4 require Java 21 or newer. If you're on 17, that upgrade comes first.

**Spring Boot 4.0 (or Framework 7.0 standalone).** In practice almost nobody uses Spring Security standalone. If you manage your version through Spring Boot, you get Spring Security 7 by moving to Boot 4. If you're doing that migration too, I wrote [The Ultimate Guide to Spring Boot 4 Migration](/posts/ultimate-guide-spring-boot-4-migration/) — read that alongside this one, because the Jackson 3 change described below is shared between them.

**Get to Spring Security 6.5 first and fix every deprecation warning.** This cannot be overstated. 6.5 ships "prepare for 7.0" support that lets you flip on the 7.0 behavior one piece at a time. Every deprecation warning you clear on 6.5 is a compile error you _won't_ be debugging on 7.0.

Here's the version baseline Spring Security 7.0 expects:

| Component          | Version                         |
| ------------------ | ------------------------------- |
| Java               | 21+                             |
| Spring Framework   | 7.0                             |
| Spring Boot        | 4.0                             |
| Jackson            | 3.0                             |
| Servlet API        | Jakarta Servlet 6.1 (Tomcat 11) |
| OpenSAML (if used) | 5.x                             |

If any of these are out of alignment, resolve them before touching security config.

## The Big Picture — What Actually Changed

Before the details, here's the mental model. Spring Security 7 is mostly about **deleting things that were deprecated in 6.x**:

1. **The Lambda DSL is now mandatory.** The old `.and()`-chained style no longer compiles.
2. **Request matching is unified on `PathPatternRequestMatcher`.** `AntPathRequestMatcher` and `MvcRequestMatcher` are removed.
3. **Authorization is unified on `AuthorizationManager`.** `AccessDecisionManager` and `AccessDecisionVoter` are removed.
4. **Jackson 3 replaces Jackson 2** for remembering serialized security context (session persistence, remember-me, etc.).
5. **OAuth2 and SAML tightened up** — password grant removed, PKCE on by default, OpenSAML 4 removed, stricter JWT validation.
6. **New capabilities** — first-class passkeys/WebAuthn, one-time-token login, and Spring Authorization Server folded into the project.

Let's take them in the order you'll hit them.

## Change 1: The Lambda DSL Is Now Mandatory

This is the change that touches the most code. In Spring Security 6 you _could_ still write the old fluent style with `.and()` to hop between configurers. In 7, that API is gone. Every configurer takes a `Customizer` lambda, and there is no `.and()` to chain them — you just call the next method.

If you migrated to `SecurityFilterChain` beans a while ago but kept the `.and()` chaining, this is your work.

**Before (Spring Security 6.x):**

```java
@Bean
SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
    http
        .authorizeHttpRequests()
            .requestMatchers("/blog/**").permitAll()
            .anyRequest().authenticated()
            .and()
        .formLogin()
            .loginPage("/login")
            .permitAll()
            .and()
        .rememberMe();
    return http.build();
}
```

**After (Spring Security 7.x):**

```java
@Bean
SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
    http
        .authorizeHttpRequests(authorize -> authorize
            .requestMatchers("/blog/**").permitAll()
            .anyRequest().authenticated()
        )
        .formLogin(formLogin -> formLogin
            .loginPage("/login")
            .permitAll()
        )
        .rememberMe(Customizer.withDefaults());
    return http.build();
}
```

A few things to internalize:

- **Each configurer gets its own lambda.** `authorizeHttpRequests(...)`, `formLogin(...)`, `csrf(...)`, etc. Everything _inside_ a configurer still chains normally — it's only the hop _between_ configurers that changed.
- **`authorizeRequests()` is fully removed.** It was replaced by `authorizeHttpRequests()` back in 6.x. If you're still calling the old one, switch now.
- **Use `Customizer.withDefaults()`** when you want a configurer enabled with no customization (like `rememberMe` above).

### The `shouldFilterAllDispatcherTypes` change

If you disabled dispatcher-type filtering, that toggle moved. Instead of turning off filtering globally, you now permit the dispatcher types explicitly:

**Before:**

```java
.authorizeHttpRequests(authorize -> authorize
    .shouldFilterAllDispatcherTypes(false)
    .anyRequest().authenticated()
)
```

**After:**

```java
.authorizeHttpRequests(authorize -> authorize
    .dispatcherTypeMatchers(DispatcherType.ERROR, DispatcherType.ASYNC).permitAll()
    .anyRequest().authenticated()
)
```

### Custom DSLs: `.apply()` → `.with()`

If you wrote a custom `AbstractHttpConfigurer`, the entry point changed from `.apply()` (removed) to `.with()`:

```java
// Before
http.apply(new MyCustomDsl());

// After
http.with(new MyCustomDsl(), Customizer.withDefaults());
```

## Change 2: PathPatternRequestMatcher Everywhere

Spring Security 7 removes `AntPathRequestMatcher` and `MvcRequestMatcher` and standardizes on `PathPatternRequestMatcher`, backed by Spring's `PathPatternParser`. This matters for two reasons: the matching _engine_ is stricter, and any place where you constructed a matcher _by hand_ needs new code.

### Stricter pattern rules

`PathPatternParser` does not allow `**` or `{*var}` wildcards in the _middle_ of a pattern — only at the end (or a capturing variable at the very end). Patterns like `/api/**/admin` that quietly worked under `AntPathMatcher` will now throw at startup. Audit your patterns for mid-path wildcards before you upgrade.

Also note: the DSL now expects **absolute URIs** (minus the context path). Relative fragments are out.

### String matchers in the DSL are fine

The good news is that the common case — passing a `String` to `requestMatchers(...)` — still works and now resolves to a `PathPatternRequestMatcher` under the hood:

```java
http.authorizeHttpRequests(authorize -> authorize
    .requestMatchers("/orders/**").authenticated()
    .anyRequest().permitAll()
);
```

You only need the explicit builder when you were previously constructing matchers manually, or when you need a servlet base path / HTTP method binding.

### Explicit builder with a base path

If you served an MVC app under a servlet path and relied on `MvcRequestMatcher`'s servlet-path awareness, build the matcher explicitly:

```java
PathPatternRequestMatcher.Builder servlet =
    PathPatternRequestMatcher.withDefaults().basePath("/mvc");

http.authorizeHttpRequests(authorize -> authorize
    .requestMatchers(servlet.matcher("/orders/**")).authenticated()
);
```

### Hand-built matchers on filters

Anywhere you handed a filter a raw URL string, you now hand it a `RequestMatcher`. Two common cases:

**Authentication filter processing URL:**

```java
// Before
UsernamePasswordAuthenticationFilter filter =
    new UsernamePasswordAuthenticationFilter(authenticationManager);
filter.setFilterProcessesUrl("/my/processing/url");

// After
UsernamePasswordAuthenticationFilter filter =
    new UsernamePasswordAuthenticationFilter(authenticationManager);
filter.setRequest(
    PathPatternRequestMatcher.withDefaults().matcher("/my/processing/url")
);
```

**SwitchUserFilter exit URL:**

```java
// Before
SwitchUserFilter switchUser = new SwitchUserFilter();
switchUser.setExitUserUrl("/exit/impersonate");

// After
SwitchUserFilter switchUser = new SwitchUserFilter();
switchUser.setExitUserMatcher(
    PathPatternRequestMatcher.withDefaults()
        .matcher(HttpMethod.POST, "/exit/impersonate")
);
```

The pattern is consistent: wherever a `String url` setter disappeared, there's a `RequestMatcher` setter that takes a `PathPatternRequestMatcher.withDefaults().matcher(...)`.

## Change 3: AuthorizationManager Replaces AccessDecisionManager

The old voter-based authorization architecture — `AccessDecisionManager`, `AccessDecisionVoter`, `AffirmativeBased`, `ConfigAttribute` — is removed. It was deprecated throughout 6.x in favor of the simpler `AuthorizationManager` API, and 7.0 finishes the job.

For the vast majority of apps, **you never touched these classes directly** — you used `authorizeHttpRequests(...)`, method security annotations, and role expressions, all of which already run on `AuthorizationManager` internally. If that's you, there's nothing to do here.

If you wrote a custom `AccessDecisionVoter`, port it to an `AuthorizationManager`:

**Before (custom voter):**

```java
public class TenantVoter implements AccessDecisionVoter<Object> {
    @Override
    public int vote(Authentication authentication, Object object,
                    Collection<ConfigAttribute> attributes) {
        // returns ACCESS_GRANTED / ACCESS_DENIED / ACCESS_ABSTAIN
    }
    // supports(...) methods
}
```

**After (AuthorizationManager):**

```java
public class TenantAuthorizationManager
        implements AuthorizationManager<RequestAuthorizationContext> {

    @Override
    public AuthorizationResult authorize(
            Supplier<Authentication> authentication,
            RequestAuthorizationContext context) {
        boolean granted = /* your logic */;
        return new AuthorizationDecision(granted);
    }
}
```

Then plug it in with `.access(...)`:

```java
http.authorizeHttpRequests(authorize -> authorize
    .requestMatchers("/tenant/**").access(new TenantAuthorizationManager())
    .anyRequest().authenticated()
);
```

The `AuthorizationManager` model is a straight functional improvement: one method, returns a decision, composes cleanly, and works identically for web requests, method invocations, and messages.

## Change 4: Jackson 3 for Security Serialization

Spring Security persists security-related objects as JSON in a handful of places — HTTP session serialization, remember-me tokens, the OAuth2 authorized-client service, CSRF token repositories. In 6.x that used Jackson 2's `ObjectMapper` and `SecurityJackson2Modules`. In 7.x it uses Jackson 3's `JsonMapper` and `SecurityJacksonModules`.

**Before (Jackson 2):**

```java
ObjectMapper mapper = new ObjectMapper();
mapper.registerModules(SecurityJackson2Modules.getModules(classLoader));
```

**After (Jackson 3):**

```java
JsonMapper mapper = JsonMapper.builder()
    .addModules(SecurityJacksonModules.getModules(classLoader))
    .build();
```

Two things worth knowing:

- **You usually don't configure this directly.** If you rely on the auto-configured setup, Boot 4 wires the Jackson 3 mapper for you. This only surfaces if you built a custom serializer for sessions or tokens.
- **Backward compatibility with existing serialized data.** Jackson 3 can still read data written by Jackson 2, so persisted sessions and remember-me tokens from before the upgrade continue to deserialize. If you have a specific need to keep Jackson 2 support around during a transition, it's available through the compatibility dependency, but for most apps the default Jackson 3 path is what you want.

If you're doing the full Spring Boot 4 migration, the broader Jackson 2 → 3 story (import changes, `spring-boot-jackson2` bridge) is covered in my [Spring Boot 4 migration guide](/posts/ultimate-guide-spring-boot-4-migration/) — the security piece is a small slice of it.

## Change 5: OAuth2 Changes

Spring Security 7 tightens the OAuth2 and OIDC stack. Three changes to know about.

### The password grant is removed

The OAuth2 Resource Owner Password Credentials grant is gone. It was removed from the OAuth 2.1 draft and has been discouraged for years because it requires your application to handle the user's raw credentials. If you were using it via `OAuth2AuthorizedClientProvider`, you need to move to a supported flow:

- **User-facing login** → Authorization Code with PKCE.
- **Machine-to-machine** → Client Credentials.

There is no drop-in replacement, because the whole point is that the pattern is unsafe. If you own the authorization server and the client, migrating to authorization code + PKCE is the right destination.

### PKCE is on by default

Proof Key for Code Exchange is now enabled by default for _all_ authorization code flows, including confidential clients. Previously PKCE was primarily a public-client concern. This is a security improvement that requires no config change — but if you have an older or non-compliant authorization server that chokes on the `code_challenge` parameter, you'll find out fast. Test your login flow against your actual IdP early.

### JWT `typ` header validation

Resource servers now validate the JWT `typ` (type) header by default. If you explicitly disabled that validation on 6.5 as a workaround, you can remove the workaround — the default is now what you wanted. If your tokens are minted without a proper `typ` header, you'll need to either fix the token issuer or configure the validator to accept them.

## Change 6: SAML 2.0 Changes

If you use SAML SSO, there are two changes.

**OpenSAML 4 is removed; you must be on OpenSAML 5.** Spring Security 7 only supports OpenSAML 5. The `OpenSaml4X...` classes are gone, replaced by `OpenSaml5...` equivalents. If Boot manages your OpenSAML version this is mostly transparent, but any direct references to the version-4 classes need updating to the version-5 names.

**GET requests are no longer processed by default.** `Saml2AuthenticationTokenConverter` and `OpenSaml5AuthenticationTokenConverter` no longer accept SAML responses over HTTP GET, because the SAML 2.0 spec doesn't define response delivery over GET. If you had an identity provider posting responses via GET (non-spec-compliant), reconfigure it to use POST binding.

## Change 7: Redirect-to-HTTPS and CSRF Tweaks

A couple of smaller but visible DSL changes.

### `requiresChannel` → `redirectToHttps`

The channel security DSL was replaced with a dedicated, clearer method:

**Before:**

```java
http.requiresChannel(channel -> channel
    .requestMatchers("/secure/**").requiresSecureChannel()
);
```

**After:**

```java
http.redirectToHttps(https -> https
    .requestMatchers("/secure/**")
);
```

### CSRF cookie customization

Setting individual cookie properties on `CookieCsrfTokenRepository` moved to a customizer:

**Before:**

```java
CookieCsrfTokenRepository csrf = CookieCsrfTokenRepository.withHttpOnlyFalse();
csrf.setCookieMaxAge(86400);
```

**After:**

```java
CookieCsrfTokenRepository csrf = CookieCsrfTokenRepository.withHttpOnlyFalse();
csrf.setCookieCustomizer(cookie -> cookie.maxAge(86400));
```

## What's New (Not Just What's Removed)

Migrations get framed as pure cost, but Spring Security 7 also brings genuinely useful additions worth adopting once you're on it.

### First-class passkeys / WebAuthn

Spring Security 7 has built-in support for passkeys — passwordless credentials built on FIDO2/WebAuthn. A passkey is a public/private key pair: the public key is stored server-side, the private key stays on the user's device and is unlocked with biometrics or a device PIN. Add the `spring-security-webauthn` module and configure it via the DSL:

```java
http.webAuthn(webAuthn -> webAuthn
    .rpName("My Application")
    .rpId("example.com")
    .allowedOrigins("https://example.com")
);
```

You'll also need a `PublicKeyCredentialUserEntityRepository` and a `UserCredentialRepository` (in-memory implementations ship for getting started; back them with a database for production). This is the cleanest way to add phishing-resistant login to a Spring app today.

### One-time-token login

Spring Security 7 includes a one-time-token (OTT) login mechanism — the "magic link" / passwordless-code pattern, built in:

```java
http.oneTimeTokenLogin(ott -> ott
    .tokenGenerationSuccessHandler(myHandler)
);
```

You supply a success handler that delivers the token to the user (email, SMS, etc.), and Spring Security handles generation, storage, and redemption. It's a first-class configurer now rather than something you hand-roll.

### Spring Authorization Server joins the family

Spring Authorization Server — the project for building your own OAuth2/OIDC provider — is now part of Spring Security proper, along with the Kerberos extension. Practically, this means tighter version alignment and a single support lifecycle rather than tracking a separate release train.

## Testing After the Migration

Your existing `spring-security-test` support carries over. `@WithMockUser`, `@WithUserDetails`, and the `SecurityMockMvcRequestPostProcessors` (`user(...)`, `jwt(...)`, `oauth2Login()`, etc.) all still work.

One thing to verify explicitly: **run your full security test suite and watch startup.** Because so many of these changes are hard removals that fail at _context initialization_ rather than at request time, a broken matcher pattern or a leftover `AccessDecisionVoter` bean will surface as a failing `@SpringBootTest` before it ever reaches a request. That's actually a gift — it means your test suite catches the migration gaps for you. If your app context loads clean and your authorization tests pass, you're in good shape.

Pay special attention to:

- **Path matching tests** — the stricter `PathPatternParser` rules mean a pattern that matched before might not now.
- **OAuth2 login tests** — PKCE-by-default changes the token request; if you mock or record the exchange, update the expectations.
- **Serialization tests** — anything asserting on the JSON shape of a persisted session or token now goes through Jackson 3.

## Using OpenRewrite to Automate the Boring Parts

You don't have to make every change by hand. The Spring team ships an OpenRewrite recipe that mechanically applies a large share of the 7.0 migration — the `.and()` removal, `authorizeRequests` → `authorizeHttpRequests`, `MvcRequestMatcher` → `PathPatternRequestMatcher`, and more.

```xml
<plugin>
    <groupId>org.openrewrite.maven</groupId>
    <artifactId>rewrite-maven-plugin</artifactId>
    <configuration>
        <activeRecipes>
            <recipe>org.openrewrite.java.spring.security7.UpgradeSpringSecurity_7_0</recipe>
        </activeRecipes>
    </configuration>
</plugin>
```

```bash
./mvnw rewrite:run
```

Run it, review the diff carefully (never blind-commit a Rewrite run), and clean up whatever it couldn't safely automate — custom voters, hand-built matchers, and OAuth2/SAML flow decisions still need a human. Treat it as a first pass that gets you 70% of the way, not a magic button.

## Migration Checklist

Here's the ordered checklist I'd follow for a real migration:

1. **Get to Spring Security 6.5 first** and fix _every_ deprecation warning. This is the whole game.
2. **Upgrade to Java 21** if you aren't already there.
3. **Move to Spring Boot 4.0** (which brings Spring Framework 7 and Spring Security 7). See my [Spring Boot 4 migration guide](/posts/ultimate-guide-spring-boot-4-migration/).
4. **Convert all security config to the Lambda DSL** — remove every `.and()`, replace any lingering `authorizeRequests()` with `authorizeHttpRequests()`.
5. **Audit request patterns** for mid-path wildcards that `PathPatternParser` rejects.
6. **Replace hand-built matchers** (`AntPathRequestMatcher`, `MvcRequestMatcher`, filter URL setters) with `PathPatternRequestMatcher`.
7. **Port any custom `AccessDecisionVoter`** to `AuthorizationManager`.
8. **Handle Jackson 3** — only if you customized security serialization.
9. **OAuth2**: remove password grant usage, test PKCE against your real IdP, verify JWT `typ` headers.
10. **SAML**: confirm OpenSAML 5, switch any GET-binding IdP responses to POST.
11. **Migrate `requiresChannel` → `redirectToHttps`** and any CSRF cookie setters to the customizer.
12. **Run the OpenRewrite recipe** to automate the mechanical bulk, then review the diff.
13. **Run the full test suite** and watch for context-load failures — they're your migration checklist writing itself.
14. _(Optional, once green)_ Adopt passkeys and one-time-token login where they fit.

Do these in order. The reason step 1 comes first is that everything below it is easier when 6.5 has already warned you about it.

## Wrapping Up

Spring Security 7 looks intimidating on paper — a dozen removals, several of them hard failures — but the shape of the migration is friendlier than the list suggests. Almost all of it is _deleting deprecated code you were already warned about_, and Spring Security 6.5 exists precisely so you can do that deletion gradually, on the previous major version, with warnings instead of errors.

If you take one thing from this post: **do not skip 6.5.** Land there, get it fully green, and the jump to 7.0 becomes a formality instead of a firefight. Combine that with the OpenRewrite recipe for the mechanical changes and a test suite that fails loud on context load, and this is a very manageable upgrade — one that leaves you on a cleaner, simpler, more secure API with passkeys and passwordless login one config block away.

## Resources

- [Spring Security 7.0 Migration Guide](https://docs.spring.io/spring-security/reference/migration/index.html) (canonical reference)
- [What's New in Spring Security 7.0](https://docs.spring.io/spring-security/reference/whats-new.html)
- [Preparing for 7.0 (from 6.5)](https://docs.spring.io/spring-security/reference/6.5/migration-7/index.html)
- [Authorize HttpServletRequests](https://docs.spring.io/spring-security/reference/servlet/authorization/authorize-http-requests.html)
- [Passkeys in Spring Security](https://docs.spring.io/spring-security/reference/servlet/authentication/passkeys.html)
- [OpenRewrite: Migrate to Spring Security 7.0](https://docs.openrewrite.org/recipes/java/spring/security7/upgradespringsecurity_7_0)
- [The Ultimate Guide to Spring Boot 4 Migration](/posts/ultimate-guide-spring-boot-4-migration/) (my companion guide)
