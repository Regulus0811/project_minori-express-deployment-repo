# Use the official Node.js image as the base image with Node.js version 18
FROM node:18

# Set the working directory inside the container
WORKDIR /app

# Install required dependencies for mediasoup and SSL
RUN apt-get update && \
    apt-get install -y \
    python3 \
    python3-pip \
    build-essential \
    python3-dev \
    pkg-config \
    openssl

# Create SSL directory
RUN mkdir -p /app/config/ssl

# Generate self-signed certificate
RUN openssl req -x509 -newkey rsa:2048 -keyout /app/config/ssl/key.pem -out /app/config/ssl/crt.pem -days 365 -nodes -subj "/CN=localhost"

# Set proper permissions for SSL files
RUN chmod 600 /app/config/ssl/key.pem /app/config/ssl/crt.pem

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the main server port
EXPOSE 8000

# Expose WebRTC ports (as defined in createWorker)
EXPOSE 2000-2020/udp
EXPOSE 2000-2020/tcp

# Start the server
CMD ["node", "server.js"]