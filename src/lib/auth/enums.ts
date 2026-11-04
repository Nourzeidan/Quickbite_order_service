// mirrors core-service app/user/enums.ts and the rbac role seed — values must stay identical
export enum SystemRole {
    ADMIN = "admin",
    RESTAURANT_USER = "restaurant_user",
    CUSTOMER = "customer",
    DELIVERY_AGENT = "delivery_agent"
}

export enum RestaurantRole {
    OWNER = "owner",
    BRANCH_MANAGER = "branch_manager",
    STAFF = "staff"
}
