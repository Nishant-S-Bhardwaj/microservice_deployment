# Ride-booking microservices

This repository contains the ride-booking application: five Node.js API services, a static browser UI, and Dockerfiles for the application services. Kubernetes and Helm deployment configuration is maintained separately in the [deployment repository](../Uber_devops_practice_deployment/README.md).

## Part 1 — Application overview

### Application flow

```text
Passenger browser
  └─ UI at /
      └─ POST /api/user/rides
          └─ User API saves ride + outbox event in PostgreSQL
              └─ RabbitMQ: ride.requested
                  └─ Route API selects the nearest available rider
                      └─ RabbitMQ: ride.offered
                          └─ Rider API stores offer
                              └─ Rider browser at /rider accepts and completes
                                  └─ RabbitMQ: ride.completed
                                      └─ Payment API calculates fare
                                          └─ RabbitMQ: payment.completed
                                              ├─ User API marks ride completed and saves fare
                                              └─ Rider API saves fare in trip history
```

The UI provides the passenger booking page at `/` and the rider page at `/rider`. Passengers enter pickup and destination labels and coordinates, request a ride, and see ride status, rider, estimated distance/time, and fare. Riders go online with their location, receive offers, accept or reject, start and complete rides, and see completed-trip history.

### Technology used

- Node.js 20 and Express 4 for the HTTP services.
- PostgreSQL (`pg`) for service-owned schemas and persistent state.
- RabbitMQ (`amqplib`) for asynchronous ride lifecycle events.
- JWT (`jsonwebtoken`) and bcryptjs in the IAM/authentication code.
- Plain HTML, CSS, and browser JavaScript for the UI, served by NGINX.
- Docker for service/UI images; kind, Kubernetes, Helm, and ingress-nginx in the separate deployment repository.

### Services and responsibilities

| Service | Responsibility | Main HTTP endpoints |
|---|---|---|
| UI | Static HTML, browser forms, ride lists, rider dashboard and offer popup | `/`, `/rider` |
| User | Passenger ride creation, retrieval, and status updates from ride events | `POST /rides`, `GET /rides`, `GET /rides/:rideId` |
| Route | Maintains an event-fed rider availability view; selects and offers rides | Event-driven; no public business API |
| Rider | Rider availability, offer decisions, trip lifecycle, completed history | `POST /online`, `GET /me`, `GET /history`, `POST /offer/accept`, `/offer/reject`, `/offer/start`, `/offer/complete` |
| Payment | Calculates and publishes a fare when a trip completes | Event-driven; no public business API |
| IAM | Signup/login and JWT issuance in application source | `POST /signup`, `POST /login`; not deployed in the current kind chart |

Each API also exposes `GET /health`. The route and payment services are workers that communicate through events; they are not meant to be visited as browser pages.

### Ports and network paths

| Component | Local example port | Container / Kubernetes port | Exposure |
|---|---:|---:|---|
| IAM (optional local service) | 3001 | 3000 | Not deployed by current chart |
| User API | 3002 | 3000 | Ingress at `/api/user/*` |
| Route API | 3003 | 3000 | Cluster-internal only |
| Rider API | 3004 | 3000 | Ingress at `/api/rider/*` |
| Payment API | 3005 | 3000 | Cluster-internal only |
| UI | — | 80 | Ingress `/` and `/rider` |
| PostgreSQL | — | 5432 | Cluster-internal only |
| RabbitMQ AMQP | — | 5672 | Cluster-internal only |
| RabbitMQ management | — | 15672 | Cluster-internal only |
| Ingress-NGINX | — | 80 / 443 | kind host ports 80 / 443 |

The local example ports are separate processes on a developer machine; all API containers listen on port `3000` by default. In Kubernetes, app and data Services are `ClusterIP`, so callers inside the cluster use service DNS names and the port shown above. The browser only reaches the UI and the User/Rider API paths through Ingress. There are deliberately no public `/route` or `/payment` API routes.

### Ride lifecycle and asynchronous events

1. The passenger submits `POST /rides` with valid pickup and dropoff coordinates.
2. User stores the ride and an integration-outbox event in the same PostgreSQL transaction. The outbox publisher sends `ride.requested` to RabbitMQ.
3. Route consumes the request, ranks available riders by proximity to pickup, estimates distance and ETA, and publishes `ride.offered`. If no rider is available, it publishes `ride.no_riders`.
4. Rider consumes the offer and updates its offer state. The browser polls `/api/rider/me` and `/api/rider/history` for current status and history; the UI also displays an offer dialog and can use browser notifications when allowed.
5. Accept, reject, start, and complete actions update Rider state and enqueue events. Route uses those events to reserve/release rider availability and, after rejection, try another rider.
6. On completion, Rider stores trip details and publishes `ride.completed`. Payment calculates and persists the fare, then publishes `payment.completed`.
7. User updates the passenger ride to `COMPLETED` with the fare; Rider updates its completed history with the same fare.

The app uses a PostgreSQL-backed outbox so a database update and the event to publish are committed together. RabbitMQ uses the durable topic exchange `rides`; each service consumes its own durable queue, and failed messages are rejected to the `rides.dead` exchange and `rides.dead.q` queue. Consumers use persistent messages and idempotency/state guards to handle duplicate deliveries safely. Each service owns its schema in the shared PostgreSQL database. Cross-service coordination is event-based; Rider history also has a fallback read of legacy completed records in the rides schema.

Route estimates are intentionally simple: straight-line distance is adjusted by a road-detour factor, and ETA uses a configurable average speed. This is a demo approximation, not live map routing. Fare defaults are configurable with `BASE_FARE`, `PRICE_PER_KM`, `PRICE_PER_MINUTE`, and `MINIMUM_FARE`.

### Data and authentication

PostgreSQL stores IAM users, passenger rides, route dispatch/rider state, rider state/history, payment records, and outbox data. RabbitMQ carries asynchronous service events. The app services create their schemas and tables at startup.

The source supports JWT auth: IAM can issue a token with passenger or rider role, and User/Rider APIs validate the token and role. In the current local deployment chart, IAM is not installed and `DEMO_AUTH_DISABLED=true` is set for User and Rider so the UI can use shared passenger/rider identities without login. This is for a trusted practice environment only. Do not expose this mode to an untrusted or public network. Keep the bypass disabled and provide proper authentication before a real deployment.

All Node.js API services still require a `JWT_SECRET` at startup, including when the demo auth bypass is configured. Local process configuration can use `DATABASE_URL` and `AMQP_URL`, or the corresponding PostgreSQL and RabbitMQ credentials; see each service's `shared/config.js`.

## Part 2 — Infrastructure and deployment

### Repository boundary

- **This application repository** contains `services/`, `ui/`, `tests/`, and app Dockerfiles.
- **The deployment repository** contains the kind cluster config, ingress-nginx values, Helm chart, and standalone Kubernetes Ingress manifest. It deploys User, Route, Rider, Payment, UI, PostgreSQL, and RabbitMQ; IAM source exists here but IAM is intentionally not part of this deployment.

See the deployment guide for the full install commands and configuration: [deployment README](../Uber_devops_practice_deployment/README.md).

### kind cluster and scheduling

The kind cluster is named `uber-platform` and has one control-plane node plus four workers:

- Three workers carry `workload=app`; API and UI Deployments select these nodes.
- One worker carries `workload=infra` and `ingress-ready=true`; PostgreSQL and RabbitMQ select `workload=infra`, while ingress-nginx selects `ingress-ready=true`.
- The infra worker maps host ports `80` and `443` to the ingress controller's ports `80` and `443`.

This separation is for local practice and scheduling organization, not production isolation or high availability.

### Ingress and browser routing

`kubernetes/ingress.yaml` in the deployment repository defines two NGINX Ingress resources:

| Public path | Backend | Rewrite |
|---|---|---|
| `/` and `/rider` | UI Service, port 80 | No API rewrite; UI NGINX serves the single-page app for `/rider` |
| `/api/user/...` | User Service, port 3000 | Removes `/api/user` before forwarding, e.g. `/api/user/rides` becomes `/rides` |
| `/api/rider/...` | Rider Service, port 3000 | Removes `/api/rider`, e.g. `/api/rider/online` becomes `/online` |
| `/route` and `/payment` | No backend | Not present in Ingress; Route and Payment are internal-only |

The UI NGINX config includes a fallback to `index.html` so the direct `/rider` URL works after a page load or refresh. Its config rejects route/payment URL prefixes rather than treating them as UI routes.

### Helm chart and Kubernetes resources

The chart is `helm/uber-microservices` in the deployment repository. The rendered resources include:

- Deployments and ClusterIP Services for User, Route, Rider, and Payment.
- A UI Deployment and ClusterIP Service on port 80.
- Single-replica PostgreSQL and RabbitMQ StatefulSets, ClusterIP Services, and 1Gi persistent volume claims.
- Readiness/liveness HTTP probes on API `/health` paths.
- Node selectors for the app and infra worker groups.
- Secret references for database, RabbitMQ, and JWT credentials.

`values.yaml` chooses the shared Docker image repository and service/UI tags, sets API container port `3000`, replicas, data service names/ports, and `demoAuthDisabled`. App image tags currently use `user`, `route`, `rider`, `payment`, and `ui`. `imagePullPolicy: Always` makes a pod pull its configured tag when it starts; it does not restart a running pod when a tag is overwritten.

The ingress controller is installed separately using `helm/ingress-nginx/values-kind.yaml`. The standalone Ingress routing rules are applied with `kubectl apply -f kubernetes/ingress.yaml`; they are not generated by the app chart.

### Build, push, and roll out images

Build and push from this repository root. Rebuild only the services whose application code changed:

```sh
docker build -t nishantbhardwaj/microservices-deployment:rider services/rider
docker build -t nishantbhardwaj/microservices-deployment:ui ui
docker push nishantbhardwaj/microservices-deployment:rider
docker push nishantbhardwaj/microservices-deployment:ui
```

From the deployment repository root, validate and apply the chart and Ingress:

```sh
helm lint helm/uber-microservices
helm upgrade --install uber helm/uber-microservices --namespace uber
kubectl apply -f kubernetes/ingress.yaml
```

When pushing a new image under an existing tag, explicitly restart its Deployment so Kubernetes creates pods that pull the new image:

```sh
kubectl rollout restart deployment/rider deployment/ui -n uber
kubectl rollout status deployment/rider -n uber
kubectl rollout status deployment/ui -n uber
kubectl get pods,services,ingress -n uber -o wide
```

Use the corresponding Deployment names for any other changed API. A successful image push alone does not deploy the code; the cluster must pull the image in a rollout. If using GitOps, sync the deployment repository after its changes are pushed.

### Health and verification

With the cluster reachable, verify `http://<machine-ip>/` for passenger booking and `http://<machine-ip>/rider` for the rider page. The Ingress-backed health endpoints are `/api/user/health` and `/api/rider/health`. Route and Payment health endpoints are intentionally not public.

For the ride flow, open passenger and rider pages in separate browser tabs, put the rider online, request a ride as passenger, then accept, start, and complete it as rider. Check passenger status/fare and rider completed history after asynchronous events have been processed. `node tests/e2e.js` exercises the service flow when all required services, PostgreSQL, and RabbitMQ are running. `node tests/demo-auth.js` checks the demo auth middleware behavior.

PostgreSQL and RabbitMQ are single replicas with local persistent volumes. PVCs do not provide backups, failover, or production-grade availability. Authentication bypass, simple route estimation, one replica per service, and these local storage settings are explicit practice/demo limitations.
