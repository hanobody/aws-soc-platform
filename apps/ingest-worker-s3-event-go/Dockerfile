FROM golang:1.25-alpine AS build
WORKDIR /app

RUN apk add --no-cache git

COPY apps/ingest-worker-s3-event-go/go.mod ./go.mod
RUN go mod download

COPY apps/ingest-worker-s3-event-go ./
RUN go build -o /out/ingest-worker-s3-event ./cmd/ingest-worker-s3-event

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
COPY --from=build /out/ingest-worker-s3-event /usr/local/bin/ingest-worker-s3-event

ENTRYPOINT ["/usr/local/bin/ingest-worker-s3-event"]
