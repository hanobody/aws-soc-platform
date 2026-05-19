FROM golang:1.25-alpine AS build
WORKDIR /app
COPY apps/matcher-worker-go/go.mod ./go.mod
RUN go mod download
COPY apps/matcher-worker-go ./
RUN go build -o /out/matcher ./cmd/matcher

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
COPY --from=build /out/matcher /usr/local/bin/matcher
CMD ["/usr/local/bin/matcher"]
