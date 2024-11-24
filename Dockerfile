# Use the official Node.js image as the base image with Node.js version 18
FROM node:18

# Set the working directory inside the container
WORKDIR /app

# Install required dependencies for mediasoup
RUN apt-get update && \
    apt-get install -y \
    python3 \
    python3-pip \
    build-essential \
    python3-dev \
    pkg-config \
    openssl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# SSL 디렉토리 생성
RUN mkdir -p /app/ssl

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --production && \
    rm -rf /tmp/npm-cache

# Copy the rest of the application code
COPY . .

# Add healthcheck endpoint for ALB
COPY healthcheck.js ./

# SSL 인증서 생성
RUN openssl req -x509 -newkey rsa:2048 -keyout /app/ssl/key.pem -out /app/ssl/crt.pem -days 365 -nodes -subj "/CN=mediasoup"

# Expose the main server port
EXPOSE 8000

# Expose WebRTC ports (as defined in createWorker)
EXPOSE 2000-2020/udp
EXPOSE 2000-2020/tcp

# Start the server
CMD ["node", "server.js"]