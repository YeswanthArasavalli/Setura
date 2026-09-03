# Security Model

<cite>
**Referenced Files in This Document**
- [auth.ts](file://supabase/functions/_shared/auth.ts)
- [rate_limit.ts](file://supabase/functions/_shared/rate_limit.ts)
- [audit.ts](file://supabase/functions/_shared/audit.ts)
- [errors.ts](file://supabase/functions/_shared/errors.ts)
- [types.ts](file://supabase/functions/_shared/types.ts)
- [create-booking/index.ts](file://supabase/functions/create-booking/index.ts)
- [cancel-booking/index.ts](file://supabase/functions/cancel-booking/index.ts)
- [09_abuse_protection_&_rate_limiting.sql](file://supabase/migrations/09_abuse_protection_&_rate_limiting.sql)
- [10_audit_&_security_engine.sql](file://supabase/migrations/10_audit_&_security_engine.sql)
- [27_role_permissions.sql](file://supabase/migrations/27_role_permissions.sql)
- [01_foundation.sql](file://supabase/migrations/01_foundation.sql)
</cite>

## Table of Contents

1. [Introduction](#introduction)
2. [Project Structure](#project-structure)
3. [Core Components](#core-components)
4. [Architecture Overview](#architecture-overview)
5. [Detailed Component Analysis](#detailed-component-analysis)
6. [Dependency Analysis](#dependency-analysis)
7. [Performance Considerations](#performance-considerations)
8. [Troubleshooting Guide](#troubleshooting-guide)
9. [Conclusion](#conclusion)
10. [Appendices](#appendices)

## Introduction

This document explains the comprehensive security model implemented in Setura
Hospital OS, focusing on:

- JWT-based authentication with token validation and user context resolution
- Multi-tenant isolation by hospital using role-based access control (RBAC)
- Granular permissions for patients, doctors, receptionists, and administrators
- Abuse protection via rate limiting, request throttling, and security
  monitoring
- Audit logging for compliance and security analysis
- Secure API patterns used across endpoints

The system enforces strict boundaries between hospitals while sharing
infrastructure, ensuring that users can only access data and operations within
their authorized scope.

## Project Structure

Security is implemented across shared middleware and database layers:

- Edge Function middleware handles authentication, authorization, rate limiting,
  and audit logging
- Database migrations define roles, permissions, abuse protection tables, and
  audit structures
- Endpoints compose these components to enforce consistent security policies

```mermaid
graph TB
subgraph "Edge Functions"
A["auth.ts"]
B["rate_limit.ts"]
C["audit.ts"]
D["errors.ts"]
E["types.ts"]
end
subgraph "Database Migrations"
F["09_abuse_protection_&_rate_limiting.sql"]
G["10_audit_&_security_engine.sql"]
H["27_role_permissions.sql"]
I["01_foundation.sql"]
end
subgraph "API Endpoints"
J["create-booking/index.ts"]
K["cancel-booking/index.ts"]
end
J --> A
J --> B
J --> C
K --> A
K --> C
A --> E
A --> D
B --> F
C --> G
A --> H
A --> I
```

**Diagram sources**

- [auth.ts:1-237](file://supabase/functions/_shared/auth.ts#L1-L237)
- [rate_limit.ts:1-124](file://supabase/functions/_shared/rate_limit.ts#L1-L124)
- [audit.ts:1-75](file://supabase/functions/_shared/audit.ts#L1-L75)
- [errors.ts:1-323](file://supabase/functions/_shared/errors.ts#L1-L323)
- [types.ts:1-329](file://supabase/functions/_shared/types.ts#L1-L329)
- [09_abuse_protection_&_rate_limiting.sql:1-729](file://supabase/migrations/09_abuse_protection_&_rate_limiting.sql#L1-L729)
- [10_audit_&_security_engine.sql:1-488](file://supabase/migrations/10_audit_&_security_engine.sql#L1-L488)
- [27_role_permissions.sql:1-273](file://supabase/migrations/27_role_permissions.sql#L1-L273)
- [01_foundation.sql:1-200](file://supabase/migrations/01_foundation.sql#L1-L200)

**Section sources**

- [auth.ts:1-237](file://supabase/functions/_shared/auth.ts#L1-L237)
- [09_abuse_protection_&_rate_limiting.sql:1-729](file://supabase/migrations/09_abuse_protection_&_rate_limiting.sql#L1-L729)
- [10_audit_&_security_engine.sql:1-488](file://supabase/migrations/10_audit_&_security_engine.sql#L1-L488)
- [27_role_permissions.sql:1-273](file://supabase/migrations/27_role_permissions.sql#L1-L273)
- [01_foundation.sql:1-200](file://supabase/migrations/01_foundation.sql#L1-L200)

## Core Components

- Authentication and Authorization:
  - JWT extraction and validation via Supabase auth client
  - Role resolution from database to ensure authoritative state
  - Hospital-scoped access enforcement before business logic
- Rate Limiting and Abuse Protection:
  - Distributed sliding window checks backed by database tables
  - Phone normalization and blocklist checks
  - Abuse scoring and temporary restrictions
- Audit Logging:
  - Fire-and-forget audit event writing
  - Immutable audit logs enforced at the database level
  - Security events tracking with risk scoring and resolution workflows
- Permission System:
  - Structured role-permission mapping
  - Centralized permission checks for RLS and Edge Functions
  - Clear separation of platform-level vs hospital-level privileges

**Section sources**

- [auth.ts:22-186](file://supabase/functions/_shared/auth.ts#L22-L186)
- [rate_limit.ts:16-124](file://supabase/functions/_shared/rate_limit.ts#L16-L124)
- [audit.ts:13-75](file://supabase/functions/_shared/audit.ts#L13-L75)
- [27_role_permissions.sql:35-273](file://supabase/migrations/27_role_permissions.sql#L35-L273)
- [10_audit_&_security_engine.sql:43-320](file://supabase/migrations/10_audit_&_security_engine.sql#L43-L320)

## Architecture Overview

The security architecture combines edge middleware with database-enforced
policies:

```mermaid
sequenceDiagram
participant Client as "Client"
participant Edge as "Edge Function"
participant Auth as "Auth Middleware"
participant DB as "PostgreSQL"
participant Audit as "Audit Logger"
Client->>Edge : HTTP Request with JWT + X-Hospital-ID
Edge->>Auth : resolveAuth(req, hospitalId)
Auth->>DB : Validate JWT via Supabase auth client
DB-->>Auth : User object or error
Auth->>DB : Load profile + role for hospital
DB-->>Auth : Profile + role
Auth-->>Edge : AuthContext (userId, hospitalId, role)
Edge->>Edge : requireRole() + hospital isolation checks
Edge->>DB : Business logic (bookings, queues, etc.)
Edge->>Audit : logAuditEvent(...)
Audit->>DB : write_audit_log(...)
DB-->>Audit : success
Edge-->>Client : Response
```

**Diagram sources**

- [auth.ts:42-124](file://supabase/functions/_shared/auth.ts#L42-L124)
- [create-booking/index.ts:95-119](file://supabase/functions/create-booking/index.ts#L95-L119)
- [audit.ts:51-75](file://supabase/functions/_shared/audit.ts#L51-L75)
- [10_audit_&_security_engine.sql:255-320](file://supabase/migrations/10_audit_&_security_engine.sql#L255-L320)

## Detailed Component Analysis

### JWT-Based Authentication Flow

- Token Extraction:
  - Extracts Bearer token from Authorization header
  - Validates presence and format
- Validation:
  - Uses Supabase auth client to validate signature, expiry, and revocation
  - Returns typed errors for missing, invalid, or expired tokens
- User Context Resolution:
  - Loads profile from database to ensure active status
  - Resolves role per hospital or primary role if no hospital context
  - Supports global_admin bypass for cross-hospital operations
- Middleware Composition:
  - withAuth wrapper provides CORS handling, correlation IDs, and error
    responses
  - Enforces required roles and hospital access before invoking handlers

```mermaid
flowchart TD
Start(["Request Entry"]) --> Extract["Extract JWT from Authorization"]
Extract --> Valid{"JWT Present?"}
Valid --> |No| Unauthorized["Throw UnauthorizedError"]
Valid --> |Yes| Validate["Validate via Supabase Auth"]
Validate --> ValidToken{"Valid?"}
ValidToken --> |No| InvalidToken["Throw UnauthorizedError"]
ValidToken --> |Yes| LoadProfile["Load Profile from DB"]
LoadProfile --> Active{"Profile Active?"}
Active --> |No| Inactive["Throw UnauthorizedError"]
Active --> |Yes| ResolveRole["Resolve Role for Hospital"]
ResolveRole --> ReturnCtx["Return AuthContext"]
ReturnCtx --> End(["Proceed to Handler"])
```

**Diagram sources**

- [auth.ts:22-124](file://supabase/functions/_shared/auth.ts#L22-L124)

**Section sources**

- [auth.ts:22-186](file://supabase/functions/_shared/auth.ts#L22-L186)

### Multi-Tenant Security Model

- Hospital Isolation:
  - All requests must include X-Hospital-ID header
  - Role resolution scoped to specific hospital
  - Global admins can operate across hospitals
- Row-Level Security:
  - Database policies restrict access to hospital-scoped data
  - RLS enabled and forced on sensitive tables
- Permission Checks:
  - has_permission function validates role-permission mappings
  - current_user_has_permission convenience wrapper for SQL policies

```mermaid
classDiagram
class AuthContext {
+string userId
+string hospitalId
+UserRoleType role
+string jwt
+DbProfile profile
}
class UserRoleType {
<<enum>>
+global_admin
+hospital_admin
+doctor
+receptionist
}
class DbProfile {
+string id
+string full_name
+boolean is_active
}
AuthContext --> UserRoleType : "has role"
AuthContext --> DbProfile : "contains profile"
```

**Diagram sources**

- [types.ts:11-15](file://supabase/functions/_shared/types.ts#L11-L15)
- [types.ts:106-116](file://supabase/functions/_shared/types.ts#L106-L116)
- [types.ts:264-270](file://supabase/functions/_shared/types.ts#L264-L270)

**Section sources**

- [auth.ts:78-124](file://supabase/functions/_shared/auth.ts#L78-L124)
- [27_role_permissions.sql:133-213](file://supabase/migrations/27_role_permissions.sql#L133-L213)
- [09_abuse_protection_&_rate_limiting.sql:627-729](file://supabase/migrations/09_abuse_protection_&_rate_limiting.sql#L627-L729)

### Role-Based Permission System

- Role Hierarchy:
  - global_admin: unrestricted access
  - hospital_admin: full hospital control
  - doctor: clinical operations only
  - receptionist: front-desk booking & communication
- Permission Matrix:
  - Structured in role_permissions table
  - Includes CREATE_BOOKING, CANCEL_BOOKING, VIEW_ANALYTICS, MANAGE_USERS, etc.
- Enforcement:
  - requireRole() in middleware for endpoint-level checks
  - has_permission() for database-level RLS policies
  - Global admin bypass for cross-hospital operations

```mermaid
flowchart TD
CheckRole["Check Required Roles"] --> HasGlobal{"Global Admin?"}
HasGlobal --> |Yes| Allow["Allow Access"]
HasGlobal --> |No| HasRole{"Has Required Role?"}
HasRole --> |Yes| Allow
HasRole --> |No| Deny["Throw RoleInsufficientError"]
```

**Diagram sources**

- [auth.ts:129-151](file://supabase/functions/_shared/auth.ts#L129-L151)
- [27_role_permissions.sql:70-126](file://supabase/migrations/27_role_permissions.sql#L70-L126)

**Section sources**

- [auth.ts:129-186](file://supabase/functions/_shared/auth.ts#L129-L186)
- [27_role_permissions.sql:35-126](file://supabase/migrations/27_role_permissions.sql#L35-L126)

### Abuse Protection Mechanisms

- Rate Limiting:
  - Sliding window approach using booking_attempt_logs table
  - Configurable window minutes and max attempts per phone number
  - IP address extraction from request headers
- Blocklist Management:
  - blocked_numbers table with restriction_status and expiration
  - Temporary restrictions for dynamic blocking
- Abuse Scoring:
  - Cumulative scoring based on suspicious activities
  - Increment_abuse_score function for tracking
- Monitoring:
  - spam_events table for different abuse types
  - Risk scoring and metadata capture

```mermaid
sequenceDiagram
participant Client as "Client"
participant RL as "Rate Limiter"
participant DB as "Database"
participant Monitor as "Abuse Monitor"
Client->>RL : checkAndLogBookingAttempt(phone, ip)
RL->>DB : Check blocked_numbers
DB-->>RL : Blocked?
RL->>DB : Count recent attempts (sliding window)
DB-->>RL : Attempt count
alt Exceeded limit
RL->>DB : Log failed attempt
RL-->>Client : RateLimitError (429)
else Within limits
RL->>DB : Log successful attempt
RL->>Monitor : increment_abuse_score (if suspicious)
RL-->>Client : Proceed
end
```

**Diagram sources**

- [rate_limit.ts:27-111](file://supabase/functions/_shared/rate_limit.ts#L27-L111)
- [09_abuse_protection_&_rate_limiting.sql:385-590](file://supabase/migrations/09_abuse_protection_&_rate_limiting.sql#L385-L590)

**Section sources**

- [rate_limit.ts:16-124](file://supabase/functions/_shared/rate_limit.ts#L16-L124)
- [09_abuse_protection_&_rate_limiting.sql:77-590](file://supabase/migrations/09_abuse_protection_&_rate_limiting.sql#L77-L590)

### Audit Logging System

- Event Types:
  - login, booking_create, booking_cancel, payment operations, admin actions
  - Severity levels: low, medium, high, critical
- Implementation:
  - Fire-and-forget logging to avoid impacting business operations
  - Centralized write_audit_log function with SECURITY DEFINER
  - Immutable audit logs enforced via database triggers
- Security Events:
  - Separate security_events table for security-specific monitoring
  - Risk scoring and resolution workflow
  - Real-time publication for live monitoring

```mermaid
flowchart TD
Action["Business Operation"] --> LogEvent["logAuditEvent(event)"]
LogEvent --> TryWrite{"Try Write Audit"}
TryWrite --> |Success| Continue["Continue Operation"]
TryWrite --> |Failure| LogError["Log Error (non-fatal)"]
LogError --> Continue
Continue --> End["Operation Complete"]
```

**Diagram sources**

- [audit.ts:51-75](file://supabase/functions/_shared/audit.ts#L51-L75)
- [10_audit_&_security_engine.sql:255-320](file://supabase/migrations/10_audit_&_security_engine.sql#L255-L320)

**Section sources**

- [audit.ts:13-75](file://supabase/functions/_shared/audit.ts#L13-L75)
- [10_audit_&_security_engine.sql:43-320](file://supabase/migrations/10_audit_&_security_engine.sql#L43-L320)

### Secure API Implementation Examples

- Create Booking Endpoint:
  - Comprehensive security checks including JWT validation, role verification,
    hospital isolation
  - Rate limiting before booking creation
  - Idempotency protection against duplicate requests
  - Audit logging for compliance
- Cancel Booking Endpoint:
  - Role-based authorization for cancellation operations
  - State validation to prevent invalid cancellations
  - Optional refund initiation with proper auditing
  - Queue recalculation and notification queuing

```mermaid
sequenceDiagram
participant Client as "Client"
participant CreateBooking as "Create Booking"
participant Auth as "Auth"
participant RateLimit as "Rate Limiter"
participant DB as "Database"
participant Audit as "Audit"
Client->>CreateBooking : POST /create-booking
CreateBooking->>Auth : resolveAuth()
Auth-->>CreateBooking : AuthContext
CreateBooking->>CreateBooking : requireRole()
CreateBooking->>RateLimit : checkAndLogBookingAttempt()
RateLimit-->>CreateBooking : Allowed/Denied
CreateBooking->>DB : Create booking (atomic)
DB-->>CreateBooking : Booking created
CreateBooking->>Audit : logAuditEvent(booking_create)
Audit-->>CreateBooking : Success
CreateBooking-->>Client : 201 Created
```

**Diagram sources**

- [create-booking/index.ts:95-607](file://supabase/functions/create-booking/index.ts#L95-L607)
- [auth.ts:42-124](file://supabase/functions/_shared/auth.ts#L42-L124)
- [rate_limit.ts:27-111](file://supabase/functions/_shared/rate_limit.ts#L27-L111)
- [audit.ts:51-75](file://supabase/functions/_shared/audit.ts#L51-L75)

**Section sources**

- [create-booking/index.ts:1-666](file://supabase/functions/create-booking/index.ts#L1-L666)
- [cancel-booking/index.ts:1-482](file://supabase/functions/cancel-booking/index.ts#L1-L482)

## Dependency Analysis

The security system has clear dependency relationships:

```mermaid
graph LR
subgraph "Authentication Layer"
A["auth.ts"]
B["errors.ts"]
C["types.ts"]
end
subgraph "Protection Layer"
D["rate_limit.ts"]
E["09_abuse_protection_&_rate_limiting.sql"]
end
subgraph "Compliance Layer"
F["audit.ts"]
G["10_audit_&_security_engine.sql"]
end
subgraph "Authorization Layer"
H["27_role_permissions.sql"]
I["01_foundation.sql"]
end
A --> B
A --> C
D --> E
F --> G
A --> H
A --> I
A --> D
A --> F
```

**Diagram sources**

- [auth.ts:1-237](file://supabase/functions/_shared/auth.ts#L1-L237)
- [rate_limit.ts:1-124](file://supabase/functions/_shared/rate_limit.ts#L1-L124)
- [audit.ts:1-75](file://supabase/functions/_shared/audit.ts#L1-L75)
- [09_abuse_protection_&_rate_limiting.sql:1-729](file://supabase/migrations/09_abuse_protection_&_rate_limiting.sql#L1-L729)
- [10_audit_&_security_engine.sql:1-488](file://supabase/migrations/10_audit_&_security_engine.sql#L1-L488)
- [27_role_permissions.sql:1-273](file://supabase/migrations/27_role_permissions.sql#L1-L273)
- [01_foundation.sql:1-200](file://supabase/migrations/01_foundation.sql#L1-L200)

**Section sources**

- [auth.ts:1-237](file://supabase/functions/_shared/auth.ts#L1-L237)
- [rate_limit.ts:1-124](file://supabase/functions/_shared/rate_limit.ts#L1-L124)
- [audit.ts:1-75](file://supabase/functions/_shared/audit.ts#L1-L75)

## Performance Considerations

- Authentication:
  - JWT validation via Supabase auth client minimizes cryptographic overhead
  - Database queries for profile and role resolution are optimized with indexes
- Rate Limiting:
  - Sliding window implementation uses efficient database queries
  - Fail-open strategy prevents service degradation during database issues
- Audit Logging:
  - Fire-and-forget pattern ensures audit failures don't impact business
    operations
  - Database-level immutability prevents performance issues from updates/deletes
- Permission Checks:
  - Centralized functions reduce repeated permission calculation overhead
  - SECURITY DEFINER functions execute with elevated privileges efficiently

[No sources needed since this section provides general guidance]

## Troubleshooting Guide

Common security-related issues and their resolutions:

- Authentication Failures:
  - Missing or invalid JWT tokens result in UnauthorizedError
  - Inactive user profiles are rejected with appropriate error messages
  - Hospital access denied when user lacks membership
- Rate Limiting Issues:
  - Phone numbers may be temporarily blocked due to excessive attempts
  - IP-based rate limiting protects against distributed attacks
  - Failed rate limit checks are logged but don't block legitimate traffic
    during database errors
- Permission Errors:
  - RoleInsufficientError indicates insufficient privileges for requested
    operation
  - HospitalAccessDeniedError shows cross-hospital access attempts
- Audit Logging Problems:
  - Audit failures are non-fatal and logged internally
  - Security events can be resolved through dedicated workflows

**Section sources**

- [errors.ts:106-151](file://supabase/functions/_shared/errors.ts#L106-L151)
- [rate_limit.ts:72-78](file://supabase/functions/_shared/rate_limit.ts#L72-L78)
- [audit.ts:68-75](file://supabase/functions/_shared/audit.ts#L68-L75)

## Conclusion

Setura Hospital OS implements a comprehensive security model that combines:

- Robust JWT-based authentication with centralized validation
- Multi-tenant isolation ensuring strict hospital data separation
- Granular role-based permissions with clear hierarchy
- Advanced abuse protection with rate limiting and monitoring
- Comprehensive audit logging for compliance and security analysis

The architecture follows security best practices including fail-open strategies
for non-critical operations, immutable audit trails, and centralized error
handling. The system scales effectively while maintaining strong security
boundaries between tenants and enforcing least-privilege access controls.

[No sources needed since this section summarizes without analyzing specific
files]

## Appendices

### Security Patterns Summary

- **Defense in Depth**: Multiple layers of security (authentication,
  authorization, rate limiting, audit)
- **Fail-Secure**: Default deny policies with explicit allow rules
- **Least Privilege**: Users receive minimum necessary permissions
- **Auditability**: All sensitive operations logged with contextual information
- **Resilience**: Non-critical security features degrade gracefully under
  failure

### Compliance Features

- Immutable audit logs prevent tampering
- Security event tracking with resolution workflows
- Role-based access controls aligned with healthcare regulations
- Comprehensive logging for forensic analysis

[No sources needed since this section provides general guidance]
