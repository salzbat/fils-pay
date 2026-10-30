# Multi-stage build of apps/settlement. Build context is the repo root.
# The binary embeds time/tzdata (cmd/settlement/main.go), so a static base
# image without OS zoneinfo still resolves Asia/Bahrain.
FROM golang:1.22 AS build

WORKDIR /src
COPY apps/settlement/go.mod apps/settlement/go.sum ./
RUN go mod download
COPY apps/settlement/ ./
RUN CGO_ENABLED=0 go build -o /out/settlement ./cmd/settlement

FROM gcr.io/distroless/static-debian12
WORKDIR /
COPY --from=build /out/settlement /settlement
